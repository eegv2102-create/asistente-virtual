import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file, session
from flask_session import Session
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError
import httpx
import bleach
from gtts import gTTS
import io
import retrying
import re

# Configurar logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar variables de entorno
load_dotenv()

# Inicializar Flask
app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'tu_clave_secreta')
app.config['SESSION_TYPE'] = 'filesystem'
Session(app)

# Inicializar Groq client globalmente
client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# Definir get_db_connection
def get_db_connection():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        conn.set_session(autocommit=False)
        return conn
    except Exception as e:
        logging.error(f"Error al conectar con la base de datos: {str(e)}")
        raise

# Validar variables de entorno
if not os.getenv("GROQ_API_KEY"):
    logging.error("GROQ_API_KEY no configurada")
if not os.getenv("DATABASE_URL"):
    logging.error("DATABASE_URL no configurada")

try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except Exception as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {}

try:
    with open("prerequisitos.json", "r", encoding="utf-8") as f:
        prerequisitos = json.load(f)
    logging.info("Prerequisitos cargados: %s", list(prerequisitos.keys()))
except Exception as e:
    logging.error(f"Error cargando prerequisitos.json: {str(e)}")
    prerequisitos = {}

def init_db():
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', avatar_id TEXT DEFAULT 'default', temas_recomendados TEXT DEFAULT '')''')
        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, nivel_explicacion TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT, animation_url TEXT)''')
        c.execute("INSERT INTO avatars (avatar_id, nombre, url, animation_url) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png", ""))
        c.execute('''CREATE TABLE IF NOT EXISTS quiz_logs
                     (id SERIAL PRIMARY KEY, usuario TEXT NOT NULL, pregunta TEXT NOT NULL, respuesta TEXT NOT NULL, es_correcta BOOLEAN NOT NULL, puntos INTEGER NOT NULL, tema TEXT NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_quiz_logs ON quiz_logs(usuario, timestamp)')
        conn.commit()
        logging.info("Base de datos inicializada correctamente: tablas creadas (progreso, logs, avatars, quiz_logs)")
        return True
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    except Exception as e:
        logging.error(f"Error inesperado al inicializar la base de datos: {str(e)}")
        return False
    finally:
        if 'conn' in locals():
            conn.close()

def cargar_temas():
    global temas
    try:
        with open('temas.json', 'r', encoding='utf-8') as f:
            temas = json.load(f)
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        logging.info(f"Temas cargados: {temas_disponibles}")
        return temas_disponibles
    except FileNotFoundError:
        logging.error("Archivo temas.json no encontrado")
        temas = {}
        return [
            'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
            'Polimorfismo', 'Clases Abstractas e Interfaces', 'Lenguaje de Modelado Unificado (UML)',
            'Diagramas UML', 'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
            'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
        ]

temas = {}
TEMAS_DISPONIBLES = cargar_temas()

def cargar_progreso(usuario):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        if row:
            return {"puntos": row[0], "temas_aprendidos": row[1], "avatar_id": row[2]}
        return {"puntos": 0, "temas_aprendidos": "", "avatar_id": "default"}
    except PsycopgError as e:
        logging.error(f"Error al cargar progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, avatar_id="default"):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, avatar_id) VALUES (%s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, avatar_id, puntos, temas_aprendidos, avatar_id))
        conn.commit()
        conn.close()
        logging.info(f"Progreso guardado para usuario {usuario}: puntos={puntos}, temas={temas_aprendidos}")
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def call_groq_api(messages, model, max_tokens, temperature):
    try:
        return client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature
        )
    except Exception as e:
        logging.error(f"Error en Groq API: {str(e)}")
        if '503' in str(e):
            raise Exception("Groq API unavailable (503). Check https://groqstatus.com/")
        raise

def buscar_respuesta_app(pregunta, historial=None, nivel_explicacion="basica", usuario="anonimo"):
    # Normalizar la pregunta para comparaciones
    pregunta_norm = pregunta.lower().strip()

    # Lista de temas válidos
    temas_validos = TEMAS_DISPONIBLES

    # Respuestas para cortesías
    respuestas_simples = {
        r"^(hola|¡hola!|buenos días|buenas tardes|qué tal|hi|saludos)(.*por favor.*)?$": 
            f"¡Hola, {usuario if usuario != 'anonimo' else 'amigo'}! Estoy listo para ayudarte con Programación Avanzada. ¿Qué quieres explorar hoy? ¿Tienes alguna pregunta adicional sobre este tema?",
        r"^(gracias|muchas gracias|gracias por.*|thank you|te agradezco)$": 
            f"¡De nada, {usuario if usuario != 'anonimo' else 'amigo'}! Me alegra ayudarte. ¿Tienes otra pregunta sobre Programación Avanzada? ¿Tienes alguna pregunta adicional sobre este tema?",
        r"^(adiós|bye|hasta luego|nos vemos|chau)$": 
            f"¡Hasta pronto, {usuario if usuario != 'anonimo' else 'amigo'}! Sigue aprendiendo y aquí estaré cuando regreses. ¿Tienes alguna pregunta adicional sobre este tema?"
    }

    # Verificar si es solo una cortesía
    for patron, respuesta in respuestas_simples.items():
        if re.match(patron, pregunta_norm) and not re.search(r"(explicame|explícame|qué es|como funciona|cómo funciona|dime sobre|quiero aprender|saber más)", pregunta_norm):
            return respuesta

    # Si contiene una consulta técnica después de una cortesía, procesar solo la parte técnica
    consulta_tecnica = re.sub(r"^(hola|¡hola!|buenos días|buenas tardes|qué tal|hi|saludos|por favor)\s*", "", pregunta_norm, flags=re.IGNORECASE)
    es_cortesia = consulta_tecnica != pregunta_norm
    pregunta_procesar = consulta_tecnica if es_cortesia else pregunta

    # Manejo de preguntas generales como "qué puedo aprender"
    if re.match(r"^(qué puedo aprender|qué me puedes enseñar|qué más puedo aprender|dime qué aprender|qué temas hay|qué sabes|qué conoces)$", pregunta_norm):
        tema_sugerido = random.choice(temas_validos)
        return (
            f"¡Qué buena pregunta, {usuario if usuario != 'anonimo' else 'amigo'}! Te recomiendo explorar **{tema_sugerido}**. "
            f"Es un tema clave en Programación Avanzada que te ayudará a entender mejor cómo estructurar y optimizar tu código. "
            f"¿Quieres que te explique más sobre {tema_sugerido}? ¿Tienes alguna pregunta adicional sobre este tema?"
        )

    # Verificar relevancia de la pregunta
    prompt_relevancia = (
        f"Eres YELIA, un tutor especializado en Programación Avanzada para Ingeniería en Telemática. "
        f"Determina si la pregunta '{pregunta_procesar}' está relacionada con los siguientes temas de Programación Avanzada: {', '.join(temas_validos)}. "
        f"Responde solo 'Sí' o 'No'."
    )
    try:
        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt_relevancia},
                {"role": "user", "content": pregunta_procesar}
            ],
            model="llama3-70b-8192",
            max_tokens=10,
            temperature=0.3
        )
        es_relevante = completion.choices[0].message.content.strip().lower() == 'sí'
        if not es_relevante:
            return (
                f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, solo puedo ayudarte con Programación Avanzada en Ingeniería en Telemática. "
                f"Algunos temas que puedo explicarte son: {', '.join(temas_validos[:3])}. ¿Qué deseas saber de la materia? "
                f"¿Tienes alguna pregunta adicional sobre este tema?"
            )
    except Exception as e:
        logging.error(f"Error al verificar relevancia: {str(e)}")
        return (
            f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, no pude procesar tu pregunta. "
            f"Intenta con una pregunta sobre Programación Avanzada, como {temas_validos[0]}. "
            f"¿Tienes alguna pregunta adicional sobre este tema?"
        )

    # Procesar pregunta técnica
    contexto = ""
    if historial:
        contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

    prompt = (
        f"Eres YELIA, un tutor especializado en Programación Avanzada para estudiantes de Ingeniería en Telemática. "
        f"Responde en español con un tono claro, amigable y motivador a la pregunta: '{pregunta_procesar}'. "
        f"Sigue estas reglas estrictamente:\n"
        f"1. Responde solo sobre los temas: {', '.join(temas_validos)}.\n"
        f"2. Nivel de explicación: '{nivel_explicacion}'.\n"
        f"   - 'basica': Solo definición clara y concisa (máximo 100 palabras), sin ejemplos ni ventajas.\n"
        f"   - 'ejemplos': Definición (máximo 100 palabras) + un ejemplo breve en Java (máximo 10 líneas).\n"
        f"   - 'avanzada': Definición (máximo 100 palabras) + ventajas (máximo 50 palabras) + ejemplo en Java (máximo 10 líneas).\n"
        f"3. Si la pregunta es ambigua (e.g., solo 'Herencia'), asume que se refiere al tema correspondiente de la lista.\n"
        f"4. Usa Markdown para estructurar la respuesta (títulos, listas, bloques de código).\n"
        f"5. Contexto: {contexto}\n"
        f"6. Al final, escribe únicamente: '¿Tienes alguna pregunta adicional sobre este tema?'\n"
        f"7. Si detectas un saludo inicial, ya fue manejado; enfócate en la parte técnica.\n"
        f"Timestamp: {int(time.time())}"
    )

    try:
        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": pregunta_procesar}
            ],
            model="llama3-70b-8192",
            max_tokens=2000,
            temperature=0.7
        )
        respuesta = completion.choices[0].message.content.strip()

        # Limpiar respuesta según nivel de explicación
        if nivel_explicacion == "basica":
            for pattern in [
                r'Ejemplo:[\s\S]*?(?=(?:^##|\Z))',
                r'Ventajas:[\s\S]*?(?=(?:^##|\Z))',
                r'Prerequisitos recomendados:[\s\S]*?(?=(?:^##|\Z))',
                r'\n\s*\n\s*'
            ]:
                respuesta = re.sub(pattern, '', respuesta, flags=re.MULTILINE)

        # Agregar prefijo de cortesía si aplica
        if es_cortesia:
            respuesta = (
                f"¡Gracias por la cortesía, {usuario if usuario != 'anonimo' else 'amigo'}! Aquí tienes tu respuesta:\n\n{respuesta.strip()}"
            )

        # Asegurar que la respuesta termine con la pregunta adicional
        if not respuesta.endswith("¿Tienes alguna pregunta adicional sobre este tema?"):
            respuesta = f"{respuesta.strip()}\n\n¿Tienes alguna pregunta adicional sobre este tema?"

        return respuesta.strip()
    except Exception as e:
        logging.error(f"Error al procesar pregunta con Groq: {str(e)}")
        return (
            f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, no pude procesar tu pregunta. "
            f"Intenta con una pregunta sobre Programación Avanzada, como {temas_validos[0]}. "
            f"¿Tienes alguna pregunta adicional sobre este tema?"
        )

def validate_quiz_format(quiz_data):
    required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]
    for key in required_keys:
        if key not in quiz_data:
            raise ValueError(f"Falta la clave {key} en el quiz")
    if not isinstance(quiz_data["opciones"], list) or len(quiz_data["opciones"]) < 2:
        raise ValueError("El quiz debe tener al menos 2 opciones")
    if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
        raise ValueError("La respuesta_correcta debe coincidir exactamente con una de las opciones")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/ask", methods=["POST"])
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def ask():
    try:
        data = request.get_json()
        if not data:
            logging.error("Solicitud sin datos en /ask")
            return jsonify({"error": "Solicitud inválida: no se proporcionaron datos"}), 400

        pregunta = bleach.clean(data.get("pregunta", "")[:500])
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        nivel_explicacion = bleach.clean(data.get("nivel_explicacion", "basica")[:50])
        avatar_id = bleach.clean(data.get("avatar_id", "default")[:50])
        historial = data.get("historial", [])[:5]

        if not pregunta:
            logging.error("Pregunta vacía en /ask")
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        if nivel_explicacion not in ["basica", "ejemplos", "avanzada"]:
            logging.warning(f"Nivel de explicación inválido: {nivel_explicacion}, usando 'basica'")
            nivel_explicacion = "basica"

        respuesta = buscar_respuesta_app(pregunta, historial, nivel_explicacion, usuario)

        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO logs (usuario, pregunta, respuesta, nivel_explicacion) VALUES (%s, %s, %s, %s)",
                (usuario, pregunta, respuesta, nivel_explicacion)
            )
            conn.commit()
            cursor.close()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar log en la base de datos: {str(e)}")

        logging.info(f"Pregunta procesada: usuario={usuario}, pregunta={pregunta}, nivel={nivel_explicacion}")
        return jsonify({"respuesta": respuesta, "video_url": None})
    except Exception as e:
        logging.error(f"Error en /ask: {str(e)}")
        return jsonify({"error": f"Error al obtener respuesta: {str(e)}"}), 500

@app.route("/quiz", methods=["POST"])
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def quiz():
    try:
        data = request.get_json()
        if not data:
            logging.error("Solicitud sin datos en /quiz")
            return jsonify({"error": "Solicitud inválida: no se proporcionaron datos"}), 400

        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        tipo_quiz = bleach.clean(data.get("tipo_quiz", "opciones"))

        if tipo_quiz not in ["opciones", "verdadero_falso"]:
            logging.error(f"Tipo de quiz inválido: {tipo_quiz}")
            return jsonify({"error": "Tipo de quiz inválido"}), 400

        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        if not temas_disponibles:
            temas_disponibles = [
                "Introducción a la POO", "Clases y Objetos", "Encapsulamiento", "Herencia",
                "Polimorfismo", "Clases Abstractas e Interfaces", "UML", "Diagramas UML",
                "Patrones de Diseño en POO", "Patrón MVC", "Acceso a Archivos",
                "Bases de Datos y ORM", "Integración POO + MVC + BD", "Pruebas y Buenas Prácticas"
            ]

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        if not temas_no_aprendidos:
            temas_no_aprendidos = temas_disponibles

        tema_seleccionado = random.choice(temas_no_aprendidos if temas_no_aprendidos else temas_disponibles)

        prompt = (
            f"Eres YELIA, un tutor de Programación Avanzada para Ingeniería en Telemática. "
            f"Genera una sola pregunta de quiz de tipo '{tipo_quiz}' sobre el tema '{tema_seleccionado}'. "
            f"La pregunta debe ser clara, precisa, con una única respuesta correcta que coincida exactamente con una de las opciones, "
            f"y diferente a cualquier pregunta generada previamente. "
            f"Devuelve un JSON válido con las claves: "
            f"'pregunta' (máximo 200 caracteres), "
            f"'opciones' (lista de opciones, cada una máximo 100 caracteres), "
            f"'respuesta_correcta' (texto exacto de una opción), "
            f"'tema' (el tema, máximo 50 caracteres), "
            f"'nivel' (siempre 'basico'). "
            f"Para tipo 'opciones', incluye exactamente 4 opciones únicas, con una sola correcta. "
            f"Para tipo 'verdadero_falso', incluye exactamente 2 opciones ('Verdadero', 'Falso'). "
            f"Asegúrate de que 'respuesta_correcta' sea idéntica a una de las opciones (sin espacios adicionales ni variaciones). "
            f"Evita términos ambiguos; por ejemplo, para herencia, usa 'Herencia', no 'Generalización'. "
            f"Usa el timestamp {int(time.time())} como semilla para unicidad. "
            f"Ejemplo: "
            f"{{\"pregunta\": \"¿Qué permite ocultar los detalles internos de una clase?\", "
            f"\"opciones\": [\"Encapsulamiento\", \"Herencia\", \"Polimorfismo\", \"Abstracción\"], "
            f"\"respuesta_correcta\": \"Encapsulamiento\", "
            f"\"tema\": \"Encapsulamiento\", "
            f"\"nivel\": \"basico\"}}"
        )

        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera la pregunta del quiz en formato JSON válido."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.2
        )

        try:
            quiz_data = json.loads(completion.choices[0].message.content.strip())
            validate_quiz_format(quiz_data)
        except (json.JSONDecodeError, ValueError) as e:
            logging.error(f"Error en el formato del quiz de Groq: {str(e)}")
            quiz_data = {
                "pregunta": f"¿Qué permite ocultar los detalles internos de una clase?" if tema_seleccionado == "Encapsulamiento" else f"¿Qué diagrama UML muestra la estructura estática?",
                "opciones": ["Encapsulamiento", "Herencia", "Polimorfismo", "Abstracción"] if tema_seleccionado == "Encapsulamiento" else ["Diagrama de Clases", "Diagrama de Actividades", "Diagrama de Estados", "Diagrama de Componentes"],
                "respuesta_correcta": "Encapsulamiento" if tema_seleccionado == "Encapsulamiento" else "Diagrama de Clases",
                "tema": tema_seleccionado,
                "nivel": "basico"
            }

        try:
            validate_quiz_format(quiz_data)
        except ValueError as e:
            logging.error(f"Formato de quiz inválido: {str(e)}")
            return jsonify({"error": str(e)}), 400

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {quiz_data['tema']}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar quiz: {str(e)}"}), 500

@app.route('/responder_quiz', methods=['POST'])
def responder_quiz():
    try:
        data = request.get_json()
        if not data:
            logging.error("Solicitud sin datos en /responder_quiz")
            return jsonify({'error': 'Solicitud inválida: no se proporcionaron datos'}), 400

        respuesta = bleach.clean(data.get('respuesta', '')[:100])
        respuesta_correcta = bleach.clean(data.get('respuesta_correcta', '')[:100])
        tema = bleach.clean(data.get('tema', 'General')[:50])
        pregunta = bleach.clean(data.get('pregunta', 'Sin pregunta')[:200])

        if not respuesta or not respuesta_correcta:
            logging.error("Faltan respuesta o respuesta_correcta en /responder_quiz")
            return jsonify({'error': 'Faltan respuesta o respuesta_correcta'}), 400

        # Normalizar respuestas para comparación robusta
        respuesta_norm = ''.join(respuesta.strip().lower().split())
        respuesta_correcta_norm = ''.join(respuesta_correcta.strip().lower().split())
        es_correcta = respuesta_norm == respuesta_correcta_norm
        logging.info(f"Comparando respuesta: '{respuesta_norm}' con correcta: '{respuesta_correcta_norm}', es_correcta: {es_correcta}")

        # Guardar en base de datos
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            puntos = 10 if es_correcta else 0
            cursor.execute(
                'INSERT INTO quiz_logs (usuario, pregunta, respuesta, es_correcta, tema, puntos) VALUES (%s, %s, %s, %s, %s, %s)',
                (session.get('usuario', 'anonimo'), pregunta, respuesta, es_correcta, tema, puntos)
            )
            conn.commit()
            cursor.close()
            conn.close()
            logging.info(f"Quiz guardado en quiz_logs: usuario={session.get('usuario', 'anonimo')}, pregunta={pregunta}, respuesta={respuesta}")
        except PsycopgError as e:
            logging.error(f"Error al guardar en quiz_logs: {str(e)}")

        # Generar explicación con Groq
        try:
            prompt = (
                f"Eres YELIA, un tutor educativo de Programación Avanzada para Ingeniería en Telemática. "
                f"El usuario respondió a la pregunta: '{pregunta}'. "
                f"La respuesta dada fue: '{respuesta}'. "
                f"La respuesta correcta es: '{respuesta_correcta}'. "
                f"La respuesta es {'correcta' if es_correcta else 'incorrecta'}. "
                f"Sigue estrictamente este formato en Markdown: "
                f"- Si es correcta: '**¡Felicidades, está bien! Seleccionaste: {respuesta}.** [Explicación breve de por qué la respuesta es correcta, máximo 50 palabras]. ¿Deseas saber más del tema o de otro tema?' "
                f"- Si es incorrecta: '**Incorrecto. Seleccionaste: {respuesta}. La respuesta correcta es: {respuesta_correcta}.** [Explicación breve de por qué la respuesta seleccionada es errónea y por qué la correcta es adecuada, máximo 50 palabras]. ¿Deseas saber más del tema o de otro tema?' "
                f"No uses términos fuera de las opciones proporcionadas ni digas 'parcialmente correcta' o 'no completa'. "
                f"Usa solo el contexto de la pregunta y las opciones. "
                f"Responde en español, en formato Markdown."
            )
            response = call_groq_api(
                messages=[{"role": "system", "content": prompt}],
                model="llama3-70b-8192",
                max_tokens=100,
                temperature=0.2
            )
            explicacion = response.choices[0].message.content.strip()
        except Exception as e:
            logging.error(f"Error al generar explicación con Groq: {str(e)}")
            explicacion = (
                f"**{'¡Felicidades, está bien! Seleccionaste: ' + respuesta + '.' if es_correcta else f'Incorrecto. Seleccionaste: {respuesta}. La respuesta correcta es: {respuesta_correcta}.'}** "
                f"{'La respuesta es correcta.' if es_correcta else 'La respuesta seleccionada no es adecuada.'} "
                f"¿Deseas saber más del tema o de otro tema?"
            )

        return jsonify({
            'es_correcta': es_correcta,
            'respuesta': explicacion
        })
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({'error': f"Error al procesar la respuesta: {str(e)}"}), 500

@app.route("/tts", methods=["POST"])
def tts():
    try:
        data = request.get_json()
        text = bleach.clean(data.get("text", "")[:1000])
        if not text:
            logging.error("Texto vacío en /tts")
            return jsonify({"error": "El texto no puede estar vacío"}), 400
        if not all(c.isprintable() or c.isspace() for c in text):
            logging.error("Texto contiene caracteres no válidos")
            return jsonify({"error": "El texto contiene caracteres no válidos"}), 400
        try:
            tts = gTTS(text=text, lang='es', tld='com.mx', timeout=10)
            audio_io = io.BytesIO()
            tts.write_to_fp(audio_io)
            audio_io.seek(0)
            logging.info("Audio generado exitosamente")
            return send_file(audio_io, mimetype='audio/mp3')
        except Exception as gtts_error:
            logging.error(f"Error en gTTS: {str(gtts_error)}")
            return jsonify({"error": f"Error en la generación de audio: {str(gtts_error)}"}), 500
    except Exception as e:
        logging.error(f"Error en /tts: {str(e)}")
        return jsonify({"error": f"Error al procesar la solicitud: {str(e)}"}), 500

@app.route("/recommend", methods=["POST"])
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def recommend():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        historial = data.get("historial", [])

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())

        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        if not temas_no_aprendidos:
            temas_no_aprendidos = temas_disponibles

        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("SELECT temas_recomendados FROM progreso WHERE usuario = %s", (usuario,))
            row = c.fetchone()
            temas_recomendados = row[0].split(",") if row and row[0] else []
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al cargar temas recomendados: {str(e)}")
            temas_recomendados = []

        temas_disponibles_para_recomendar = [t for t in temas_no_aprendidos if t not in temas_recomendados[-3:]]
        if not temas_disponibles_para_recomendar:
            temas_disponibles_para_recomendar = temas_no_aprendidos

        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        prompt = (
            "Eres YELIA, un tutor de Programación Avanzada para Ingeniería en Telemática. "
            "Recomienda UN SOLO tema de Programación Avanzada (ej. POO, UML, patrones de diseño, concurrencia) basado en el historial. "
            "Elige un tema que no esté en los últimos 3 recomendados. "
            "Devuelve un objeto JSON con una clave 'recommendation' (ej. {'recommendation': 'Polimorfismo'}). "
            "NO incluyas explicaciones adicionales. "
            f"Contexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_disponibles_para_recomendar)}\nTimestamp: {int(time.time())}"
        )

        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Recomienda un tema."}
            ],
            model="llama3-70b-8192",
            max_tokens=50,
            temperature=0.7
        )

        try:
            recomendacion_data = json.loads(completion.choices[0].message.content)
            recomendacion = recomendacion_data.get("recommendation", "")
        except json.JSONDecodeError as je:
            logging.error(f"Error al decodificar JSON de Groq en /recommend: {str(je)}")
            recomendacion = random.choice(temas_disponibles_para_recomendar) if temas_disponibles_para_recomendar else random.choice(temas_disponibles)
            logging.warning(f"Usando recomendación de fallback: {recomendacion}")

        temas_recomendados.append(recomendacion)
        if len(temas_recomendados) > 5:
            temas_recomendados = temas_recomendados[-5:]
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("UPDATE progreso SET temas_recomendados = %s WHERE usuario = %s", (",".join(temas_recomendados), usuario))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar temas recomendados: {str(e)}")

        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logging.info(f"Recomendación para usuario {usuario}: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)
        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logging.warning(f"Usando recomendación de fallback por error: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto})

@app.route("/temas", methods=["GET"])
def get_temas():
    try:
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        logging.info(f"Temas disponibles enviados: {temas_disponibles}")
        return jsonify({"temas": temas_disponibles})
    except Exception as e:
        logging.error(f"Error en /temas: {str(e)}")
        return jsonify({"error": "Error al obtener temas"}), 500

if __name__ == "__main__":
    if not init_db():
        logging.error("No se pudo inicializar la base de datos. Verifica DATABASE_URL.")
        exit(1)
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))