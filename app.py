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

@app.route("/")
def index():
    return render_template("index.html")

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
        conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
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
        conn.commit()
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    return True

def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
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
        conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
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

    # Corrección: Asegurar que se devuelva solo la definición para nivel básico
    if tema_encontrado and unidad_encontrada:
        definicion = temas[unidad_encontrada][tema_encontrado]["definición"]
        if nivel_explicacion == "basica":
            return definicion  # Devolver solo la definición sin ejemplo
        elif nivel_explicacion == "ejemplos":
            ejemplo_codigo = temas[unidad_encontrada][tema_encontrado].get("ejemplo", "")
            return f"{definicion}\n\n**Ejemplo**:\n```java\n{ejemplo_codigo}\n```"
        else:  # avanzada
            ventajas = temas[unidad_encontrada][tema_encontrado].get("ventajas", [])
            ventajas_texto = "\n\n**Ventajas**:\n" + "\n".join(f"- {v}" for v in ventajas) if ventajas else ""
            ejemplo_codigo = temas[unidad_encontrada][tema_encontrado].get("ejemplo", "")
            return f"{definicion}{ventajas_texto}\n\n**Ejemplo**:\n```java\n{ejemplo_codigo}\n```"
    
    # Lógica para manejar consultas no relacionadas con temas específicos
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
        # Limpieza de la respuesta
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
    required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema", "tipo_quiz"]
    for key in required_keys:
        if key not in quiz_data:
            raise ValueError(f"Falta la clave {key} en el quiz")
    if not isinstance(quiz_data["opciones"], list) or len(quiz_data["opciones"]) < 2:
        raise ValueError("El quiz debe tener al menos 2 opciones")
    if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
        raise ValueError("La respuesta_correcta debe coincidir exactamente con una de las opciones")
    
@app.route("/quiz", methods=["POST"])
def quiz():
    try:
        data = request.get_json()
        tipo = bleach.clean(data.get("tipo", "opciones")[:20])
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        historial = data.get("historial", [])

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        tema = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)

        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            f"Eres un tutor de Programación Avanzada. Crea una pregunta de quiz sobre el tema '{tema}' "
            f"para estudiantes de Ingeniería en Telemática. La pregunta debe ser de tipo {tipo} (opciones múltiples o verdadero/falso). "
            f"Devuelve un objeto JSON con las claves: 'pregunta' (texto de la pregunta), 'opciones' (lista de 4 opciones para tipo 'opciones' o 2 para 'verdadero/falso'), "
            f"'respuesta_correcta' (texto exacto de la opción correcta), y 'tema' (el tema elegido). "
            f"Contexto: {contexto}\nTimestamp: {int(time.time())}"
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera una pregunta de quiz."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.7
        )

        quiz_data = json.loads(completion.choices[0].message.content)
        pregunta = quiz_data.get("pregunta", "")
        opciones = quiz_data.get("opciones", [])
        respuesta_correcta = quiz_data.get("respuesta_correcta", "")
        tema = quiz_data.get("tema", tema)

        if not pregunta or not opciones or not respuesta_correcta:
            logging.error("Datos incompletos en la respuesta del quiz")
            return jsonify({"error": "No se pudo generar el quiz"}), 500

        logging.info(f"Quiz generado para usuario {usuario}: {pregunta}")
        return jsonify({
            "pregunta": pregunta,
            "opciones": opciones,
            "respuesta_correcta": respuesta_correcta,
            "tema": tema
        })
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar quiz: {str(e)}"}), 500   

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta", "")[:100])
        tema = bleach.clean(data.get("tema", "")[:100])
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", "")[:100])  # Asegúrate de que el frontend envíe esto

        if not respuesta or not tema or not respuesta_correcta:
            logging.error("Faltan datos en /responder_quiz")
            return jsonify({"error": "Faltan datos en la solicitud"}), 400

        progreso = cargar_progreso(usuario)
        puntos = progreso["puntos"]
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []

        es_correcta = respuesta.lower() == respuesta_correcta.lower()
        if es_correcta:
            puntos += 10
            if tema and tema not in temas_aprendidos:
                temas_aprendidos.append(tema)
            mensaje = f"✅ ¡Correcto! Has ganado 10 puntos. Tema: {tema}. ¿Deseas saber más?"
        else:
            mensaje = f"❌ Incorrecto. La respuesta correcta era: {respuesta_correcta}. ¿Deseas saber más?"

        guardar_progreso(usuario, puntos, ",".join(temas_aprendidos))
        logging.info(f"Quiz respondido por {usuario}: {mensaje}")
        return jsonify({"respuesta": mensaje, "es_correcta": es_correcta})
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error al responder quiz: {str(e)}"}), 500

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

        # Cargar progreso del usuario
        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())

        # Seleccionar temas no aprendidos
        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        if not temas_no_aprendidos:
            temas_no_aprendidos = temas_disponibles  # Si no hay temas no aprendidos, usar todos

        # Cargar historial de recomendaciones recientes desde la base de datos
        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
            c = conn.cursor()
            c.execute("SELECT temas_recomendados FROM progreso WHERE usuario = %s", (usuario,))
            row = c.fetchone()
            temas_recomendados = row[0].split(",") if row and row[0] else []
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al cargar temas recomendados: {str(e)}")
            temas_recomendados = []

        # Filtrar temas no recomendados recientemente
        temas_disponibles_para_recomendar = [t for t in temas_no_aprendidos if t not in temas_recomendados[-3:]]  # Evitar los últimos 3 recomendados
        if not temas_disponibles_para_recomendar:
            temas_disponibles_para_recomendar = temas_no_aprendidos  # Si no hay temas nuevos, permitir repetición

        # Definir contexto a partir del historial
        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        # Configurar cliente Groq
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
            max_tokens=50,  # Reducido para respuesta más precisa
            temperature=0.7
        )

        # Procesar la respuesta
        try:
            recomendacion_data = json.loads(completion.choices[0].message.content)
            recomendacion = recomendacion_data.get("recommendation", "")
        except json.JSONDecodeError as je:
            logging.error(f"Error al decodificar JSON de Groq en /recommend: {str(je)}")
            recomendacion = random.choice(temas_disponibles_para_recomendar) if temas_disponibles_para_recomendar else random.choice(temas_disponibles)
            logging.warning(f"Usando recomendación de fallback: {recomendacion}")

        # Verificar prerequisitos
        if recomendacion in temas_disponibles:
            unidad = next(u for u, s in temas.items() if recomendacion in s)
            prereqs = prerequisitos.get(unidad, {}).get(recomendacion, [])
            if not all(prereq in temas_aprendidos for prereq in prereqs):
                # Si no cumple prerequisitos, elegir otro tema
                temas_validos = [t for t in temas_disponibles_para_recomendar if all(p in temas_aprendidos for p in prerequisitos.get(next(u for u, s in temas.items() if t in s), {}).get(t, []))]
                recomendacion = random.choice(temas_validos) if temas_validos else random.choice(temas_disponibles_para_recomendar)

        # Actualizar historial de recomendaciones
        temas_recomendados.append(recomendacion)
        if len(temas_recomendados) > 5:  # Limitar historial a 5 temas
            temas_recomendados = temas_recomendados[-5:]
        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
            c = conn.cursor()
            c.execute("UPDATE progreso SET temas_recomendados = %s WHERE usuario = %s", (",".join(temas_recomendados), usuario))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar temas recomendados: {str(e)}")

        # Formatear como texto plano
        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logging.info(f"Recomendación para usuario {usuario}: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        # Fallback en caso de error
        recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)
        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logging.warning(f"Usando recomendación de fallback por error: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto})
    
if __name__ == "__main__":
    init_db()
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))