
import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file
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

app = Flask(__name__)
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Definir get_db_connection
def get_db_connection():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
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
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, video_url TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT, animation_url TEXT)''')
        c.execute("INSERT INTO avatars (avatar_id, nombre, url, animation_url) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png", ""))
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        c.execute('''CREATE TABLE IF NOT EXISTS quiz_logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, es_correcta BOOLEAN, puntos INTEGER, tema TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        conn.commit()
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    return True

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
def call_groq_api(client, messages, model, max_tokens, temperature):
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

def buscar_respuesta_app(pregunta, historial=None, nivel_explicacion="basica"):
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    respuestas_simples = {
        "hola": "¡Hola! Estoy listo para ayudarte con Programación Avanzada. ¿Qué tema quieres explorar?",
        "gracias": "¡De nada! Sigue aprendiendo, estoy aquí para apoyarte.",
        "adiós": "¡Hasta pronto! Espero verte de nuevo para seguir aprendiendo."
    }
    if pregunta.lower().strip() in respuestas_simples:
        return respuestas_simples[pregunta.lower().strip()]

    tema_encontrado = None
    unidad_encontrada = None
    for unidad, subtemas in temas.items():
        for sub_tema_id, sub_tema_data in subtemas.items():
            palabras_clave = [sub_tema_id.lower()] + [w.lower() for w in sub_tema_data.get("ventajas", [])] + sub_tema_data["definición"].lower().split()
            if sub_tema_id.lower() in pregunta.lower() or any(kw in pregunta.lower() for kw in palabras_clave):
                tema_encontrado = sub_tema_id
                unidad_encontrada = unidad
                break
        if tema_encontrado:
            break

    contexto = ""
    if historial:
        contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

    if tema_encontrado and unidad_encontrada:
        definicion = temas[unidad_encontrada][tema_encontrado]["definición"]
        if nivel_explicacion == "basica":
            return definicion
        elif nivel_explicacion == "ejemplos":
            ejemplo_codigo = temas[unidad_encontrada][tema_encontrado].get("ejemplo", "")
            return f"{definicion}\n\n**Ejemplo**:\n```java\n{ejemplo_codigo}\n```"
        else:  # avanzada
            ventajas = temas[unidad_encontrada][tema_encontrado].get("ventajas", [])
            ventajas_texto = "\n\n**Ventajas**:\n" + "\n".join(f"- {v}" for v in ventajas) if ventajas else ""
            ejemplo_codigo = temas[unidad_encontrada][tema_encontrado].get("ejemplo", "")
            return f"{definicion}{ventajas_texto}\n\n**Ejemplo**:\n```java\n{ejemplo_codigo}\n```"
    
    prompt = (
        f"Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
        f"Proporciona una respuesta clara y precisa en español para la pregunta: '{pregunta}'. "
        f"Contexto: {contexto}\n"
        f"Nivel de explicación: {nivel_explicacion}. "
        f"Si es 'basica', explica solo el concepto sin ejemplos ni ventajas. "
        f"Si es 'ejemplos', incluye un ejemplo de código en Java. "
        f"Si es 'avanzada', incluye definición, ventajas y ejemplos. "
        f"Timestamp: {int(time.time())}"
    )

    try:
        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": pregunta}
            ],
            model="llama3-70b-8192",
            max_tokens=2000,
            temperature=0.7
        )
        respuesta = completion.choices[0].message.content
        if nivel_explicacion == "basica":
            for pattern in [
                r'Ejemplo:[\s\S]*?(?=(?:^##|\Z))',
                r'Ventajas:[\s\S]*?(?=(?:^##|\Z))',
                r'Prerequisitos recomendados:[\s\S]*?(?=(?:^##|\Z))',
                r'\?Deseas saber más\?',
                r'\n\s*\n\s*'
            ]:
                respuesta = re.sub(pattern, '', respuesta, flags=re.MULTILINE)
        return respuesta.strip()
    except Exception as e:
        logging.error(f"Error al procesar pregunta con Groq: {str(e)}")
        return "Lo siento, no pude procesar tu pregunta. Intenta de nuevo."

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

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            f"Eres YELIA, un asistente especializado en Programación Avanzada en Ingeniería en Telemática. "
            f"Responde a la pregunta '{pregunta}' de manera clara, precisa y específica al concepto preguntado, "
            f"evitando definiciones genéricas sobre Programación Orientada a Objetos (POO). "
            f"Adapta la respuesta según el nivel de explicación: "
            f"- 'basica': Explicación simple, breve y sin tecnicismos profundos, sin ejemplos. "
            f"- 'ejemplos': Explicación clara con un ejemplo práctico en Java, relevante al concepto preguntado. "
            f"- 'avanzada': Explicación técnica y detallada, con análisis teórico profundo, sin ejemplos a menos que se soliciten explícitamente. "
            f"Si el nivel es 'ejemplos', incluye un bloque de código en Java con comentarios explicativos. "
            f"Historial reciente: {json.dumps(historial, ensure_ascii=False)}. "
            f"Devuelve solo el texto de la respuesta en formato Markdown, sin envolver en bloques de código JSON ni otros formatos"
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": pregunta}
            ],
            model="llama3-70b-8192",
            max_tokens=1000,
            temperature=0.5
        )

        respuesta = completion.choices[0].message.content.strip()

        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO logs (usuario, pregunta, respuesta, avatar_id, nivel_explicacion) VALUES (%s, %s, %s, %s, %s)",
                (usuario, pregunta, respuesta, avatar_id, nivel_explicacion)
            )
            conn.commit()
            cursor.close()
            conn.close()
        except Exception as e:
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
            logging.error("No hay temas disponibles en temas.json")
            return jsonify({"error": "No hay temas disponibles"}), 500
        tema = random.choice(temas_disponibles)

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            f"Genera una sola pregunta de quiz de tipo {tipo_quiz} sobre el tema '{tema}' en Programación Avanzada. "
            "Devuelve un JSON válido con las siguientes claves: "
            "'pregunta' (texto de la pregunta, máximo 200 caracteres), "
            "'opciones' (lista de opciones, cada una máximo 100 caracteres), "
            "'respuesta_correcta' (texto exacto de una de las opciones), "
            "'tema' (el tema, máximo 50 caracteres), "
            "'nivel' (siempre 'basico'). "
            f"Para tipo 'opciones', incluye exactamente 4 opciones únicas. "
            f"Para tipo 'verdadero_falso', incluye exactamente 2 opciones ('Verdadero', 'Falso'). "
            "Asegúrate de que 'respuesta_correcta' coincide exactamente con una de las opciones en 'opciones'. "
            "Ejemplo de formato: "
            "{\"pregunta\": \"¿Qué es la encapsulación en POO?\", "
            "\"opciones\": [\"Ocultar datos\", \"Herencia\", \"Polimorfismo\", \"Abstracción\"], "
            "\"respuesta_correcta\": \"Ocultar datos\", "
            "\"tema\": \"POO\", "
            "\"nivel\": \"basico\"}"
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera la pregunta del quiz en formato JSON válido."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.7
        )

        try:
            quiz_data = json.loads(completion.choices[0].message.content.strip())
            required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]
            if not isinstance(quiz_data, dict) or not all(key in quiz_data for key in required_keys):
                logging.error(f"Formato de quiz inválido, claves faltantes: {quiz_data}")
                raise ValueError("Formato de quiz inválido: faltan claves requeridas")
            if tipo_quiz == "opciones" and len(quiz_data["opciones"]) != 4:
                logging.error(f"Número incorrecto de opciones para tipo 'opciones': {len(quiz_data['opciones'])}")
                quiz_data = {
                    "pregunta": f"¿Qué es {tema} en Programación Avanzada?",
                    "opciones": ["Ocultar datos", "Herencia", "Polimorfismo", "Abstracción"],
                    "respuesta_correcta": "Ocultar datos",
                    "tema": tema,
                    "nivel": "basico"
                }
            if tipo_quiz == "verdadero_falso" and len(quiz_data["opciones"]) != 2:
                logging.error(f"Número incorrecto de opciones para tipo 'verdadero_falso': {len(quiz_data['opciones'])}")
                quiz_data = {
                    "pregunta": f"{tema} permite ocultar datos en Programación Avanzada.",
                    "opciones": ["Verdadero", "Falso"],
                    "respuesta_correcta": "Verdadero",
                    "tema": tema,
                    "nivel": "basico"
                }
            if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
                logging.error(f"Respuesta correcta no está en opciones: {quiz_data['respuesta_correcta']}")
                raise ValueError("La respuesta correcta debe estar en la lista de opciones")
        except json.JSONDecodeError:
            logging.error(f"Respuesta de Groq no es un JSON válido: {completion.choices[0].message.content}")
            quiz_data = {
                "pregunta": f"¿Qué es {tema} en Programación Avanzada?" if tipo_quiz == "opciones" else f"{tema} permite ocultar datos en Programación Avanzada.",
                "opciones": ["Ocultar datos", "Herencia", "Polimorfismo", "Abstracción"] if tipo_quiz == "opciones" else ["Verdadero", "Falso"],
                "respuesta_correcta": "Ocultar datos" if tipo_quiz == "opciones" else "Verdadero",
                "tema": tema,
                "nivel": "basico"
            }
        except ValueError as ve:
            logging.error(f"Error en el formato del quiz: {str(ve)}")
            quiz_data = {
                "pregunta": f"¿Qué es {tema} en Programación Avanzada?" if tipo_quiz == "opciones" else f"{tema} permite ocultar datos en Programación Avanzada.",
                "opciones": ["Ocultar datos", "Herencia", "Polimorfismo", "Abstracción"] if tipo_quiz == "opciones" else ["Verdadero", "Falso"],
                "respuesta_correcta": "Ocultar datos" if tipo_quiz == "opciones" else "Verdadero",
                "tema": tema,
                "nivel": "basico"
            }

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {tema}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        quiz_data = {
            "pregunta": f"¿Qué es {tema} en Programación Avanzada?" if tipo_quiz == "opciones" else f"{tema} permite ocultar datos en Programación Avanzada.",
            "opciones": ["Ocultar datos", "Herencia", "Polimorfismo", "Abstracción"] if tipo_quiz == "opciones" else ["Verdadero", "Falso"],
            "respuesta_correcta": "Ocultar datos" if tipo_quiz == "opciones" else "Verdadero",
            "tema": tema,
            "nivel": "basico"
        }
        logging.info(f"Devolviendo quiz por defecto para usuario {usuario} sobre tema {tema}: {quiz_data}")
        return jsonify(quiz_data)

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        logging.info(f"Datos recibidos en /responder_quiz: {data}")
        if not data:
            logging.error("Solicitud sin datos en /responder_quiz")
            return jsonify({"error": "Solicitud inválida: no se proporcionaron datos"}), 400

        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta", ""))
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", ""))
        tema = bleach.clean(data.get("tema", ""))
        pregunta = bleach.clean(data.get("pregunta", "Pregunta de quiz")[:500])  # Default si falta

        if not all([respuesta, respuesta_correcta, tema]):
            logging.error(f"Faltan datos en /responder_quiz: respuesta={respuesta}, respuesta_correcta={respuesta_correcta}, tema={tema}, pregunta={pregunta}")
            return jsonify({"error": "Faltan datos requeridos (respuesta, respuesta_correcta o tema)"}), 400

        es_correcta = respuesta == respuesta_correcta
        puntos = 10 if es_correcta else 0

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            f"Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            f"El usuario respondió a la pregunta '{pregunta}' con la respuesta '{respuesta}'. "
            f"La respuesta correcta es '{respuesta_correcta}'. "
            f"El tema es '{tema}'. "
            f"Proporciona una retroalimentación clara, educativa y concisa en español (máximo 200 palabras). "
            f"Si la respuesta es correcta, explica brevemente por qué es correcta. "
            f"Si es incorrecta, explica por qué la respuesta del usuario es incorrecta y por qué la respuesta correcta es la adecuada. "
            f"Termina con '¿Deseas saber más?'"
        )

        try:
            completion = call_groq_api(
                client,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": "Proporciona la retroalimentación."}
                ],
                model="llama3-70b-8192",
                max_tokens=300,
                temperature=0.7
            )
            feedback = completion.choices[0].message.content.strip()
        except Exception as e:
            logging.error(f"Error al obtener retroalimentación de Groq: {str(e)}")
            feedback = (
                f"{'✅ ¡Correcto!' if es_correcta else f'❌ Incorrecto. La respuesta correcta era: {respuesta_correcta}.'} "
                f"{'Has ganado 10 puntos.' if es_correcta else 'No has ganado puntos.'} "
                f"Tema: {tema}. ¿Deseas saber más?"
            )

        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO quiz_logs (usuario, pregunta, respuesta, es_correcta, puntos, tema) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (usuario, pregunta, respuesta, es_correcta, puntos, tema)
            )
            conn.commit()
            cursor.close()
            conn.close()
        except Exception as e:
            logging.error(f"Error al guardar log en la base de datos: {str(e)}")

        try:
            progreso = cargar_progreso(usuario)
            puntos_totales = progreso["puntos"] + puntos
            temas_aprendidos = progreso["temas_aprendidos"]
            if es_correcta and tema not in temas_aprendidos.split(","):
                temas_aprendidos = temas_aprendidos + f",{tema}" if temas_aprendidos else tema
            guardar_progreso(usuario, puntos_totales, temas_aprendidos)
        except Exception as e:
            logging.error(f"Error al actualizar progreso: {str(e)}")

        logging.info(f"Respuesta procesada: es_correcta={es_correcta}, puntos={puntos}, tema={tema}")
        return jsonify({
            "es_correcta": es_correcta,
            "respuesta": feedback,
            "puntos": puntos
        })
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error interno: {str(e)}"}), 500

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

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            "Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            "Tu tarea es recomendar UN SOLO tema de Programación Avanzada basado en el historial de interacciones y los temas ya aprendidos. "
            "Elige un tema de los disponibles que no haya sido aprendido, considerando el contexto del historial y los prerequisitos. "
            "Devuelve un objeto JSON con una clave 'recommendation' que contenga el nombre de UN SOLO tema (por ejemplo, {'recommendation': 'Polimorfismo'}). "
            "NO incluyas explicaciones adicionales fuera del JSON."
            f"\nContexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_disponibles_para_recomendar)}\nTimestamp: {int(time.time())}"
            f"\nPrerequisitos: {json.dumps(prerequisitos)}"
        )

        completion = call_groq_api(
            client,
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

        if recomendacion in temas_disponibles:
            unidad = next(u for u, s in temas.items() if recomendacion in s)
            prereqs = prerequisitos.get(unidad, {}).get(recomendacion, [])
            if not all(prereq in temas_aprendidos for prereq in prereqs):
                temas_validos = [t for t in temas_disponibles_para_recomendar if all(p in temas_aprendidos for p in prerequisitos.get(next(u for u, s in temas.items() if t in s), {}).get(t, []))]
                recomendacion = random.choice(temas_validos) if temas_validos else random.choice(temas_disponibles_para_recomendar)

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

if __name__ == "__main__":
    init_db()
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))
