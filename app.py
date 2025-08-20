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
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', avatar_id TEXT DEFAULT 'default')''')
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

    if nivel_explicacion == "basica":
        estilo_prompt = (
            "Explica de manera sencilla y clara, como si le hablaras a un principiante que recién comienza en Programación Avanzada. "
            "Proporciona solo la definición del concepto preguntado, sin ejemplos, ventajas, prerequisitos ni preguntas adicionales. "
            "Usa un lenguaje simple, evita tecnicismos complejos y enfócate en conceptos básicos."
        )
        secciones_no_deseadas = [
            r'Ejemplo:[\s\S]*?(?=(?:^##|\Z))',
            r'Ventajas:[\s\S]*?(?=(?:^##|\Z))',
            r'Prerequisitos recomendados:[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?',
            r'\n\s*\n\s*'
        ]
    elif nivel_explicacion == "ejemplos":
        estilo_prompt = (
            "Proporciona la definición del concepto preguntado, seguida de un ejemplo de código claro y conciso que ilustre el concepto. "
            "Usa un lenguaje claro y de nivel intermedio, adecuado para alguien con conocimientos básicos de programación. "
            "No incluyas ventajas, prerequisitos ni preguntas adicionales. "
            "Asegúrate de que el ejemplo de código esté bien comentado y sea relevante al concepto."
        )
        secciones_no_deseadas = [
            r'Ventajas:[\s\S]*?(?=(?:^##|\Z))',
            r'Prerequisitos recomendados:[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?',
            r'\n\s*\n\s*'
        ]
    elif nivel_explicacion == "avanzada":
        estilo_prompt = (
            "Proporciona una explicación teórica avanzada del concepto preguntado, incluyendo detalles profundos y referencias a estándares si aplica. "
            "Usa un lenguaje técnico, pero claro, dirigido a alguien con experiencia en Programación Avanzada. "
            "Proporciona solo la definición teórica, sin ejemplos, ventajas, prerequisitos ni preguntas adicionales."
        )
        secciones_no_deseadas = [
            r'Ejemplo:[\s\S]*?(?=(?:^##|\Z))',
            r'Ventajas:[\s\S]*?(?=(?:^##|\Z))',
            r'Prerequisitos recomendados:[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?',
            r'\n\s*\n\s*'
        ]

    prompt = (
        f"{estilo_prompt}\n"
        f"Pregunta del usuario: {pregunta}\n"
        f"Contexto: {contexto}"
    )

    try:
        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": "Eres un tutor experto en Programación Avanzada."},
                {"role": "user", "content": prompt}
            ],
            model="llama3-70b-8192",
            max_tokens=500,
            temperature=0.7
        )
        respuesta = completion.choices[0].message.content.strip()
        # Limpieza adicional para eliminar secciones no deseadas según el nivel
        for regex in secciones_no_deseadas:
            respuesta = re.sub(regex, '', respuesta, flags=re.MULTILINE).strip()
        return respuesta
    except Exception as e:
        logging.error(f"Error en Groq API: {str(e)}")
        return "Lo siento, el servicio de IA está temporalmente no disponible. Intenta más tarde o verifica https://groqstatus.com/."
    
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/ask", methods=["POST"])
def ask():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        pregunta = bleach.clean(data.get("pregunta", "")[:300])
        historial = data.get("historial", [])
        nivel_explicacion = bleach.clean(data.get("nivel_explicacion", "basica"))

        if not pregunta:
            logging.error("Pregunta vacía en /ask")
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        respuesta = buscar_respuesta_app(pregunta, historial, nivel_explicacion)
        if "no disponible" in respuesta:
            return jsonify({"respuesta": respuesta}), 503

        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"), connect_timeout=10)
            c = conn.cursor()
            c.execute("INSERT INTO logs (usuario, pregunta, respuesta) VALUES (%s, %s, %s)",
                      (usuario, pregunta, respuesta))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar log: {str(e)}")

        logging.info(f"Pregunta de {usuario}: {pregunta} - Respuesta: {respuesta}")
        return jsonify({"respuesta": respuesta})
    except Exception as e:
        logging.error(f"Error en /ask: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/quiz", methods=["POST"])
def quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        tipo_quiz = bleach.clean(data.get("tipo", "opciones")[:20])
        tema = bleach.clean(data.get("tema", "")[:50])
        nivel_explicacion = bleach.clean(data.get("nivel", "basica")[:20])

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []

        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        tema = tema if tema in temas_disponibles else random.choice(temas_disponibles)

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        # Añadir timestamp para forzar variación en las preguntas
        prompt = (
            f"Eres un tutor de Programación Avanzada. Genera un quiz de tipo {tipo_quiz} sobre el tema '{tema}'. "
            f"El nivel de explicación debe ser {nivel_explicacion}. "
            f"Genera una pregunta única (no repitas preguntas anteriores). "
            "Devuelve un JSON con: pregunta (string), opciones (array de strings), respuesta_correcta (string, debe coincidir exactamente con una opción), tema (string)."
            f"Contexto: usuario ha aprendido {','.join(temas_aprendidos)}. Timestamp: {int(time.time())}"
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera un quiz."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.9  # Aumentar temperatura para más variación
        )

        quiz_data = json.loads(completion.choices[0].message.content)
        try:
            validate_quiz_format(quiz_data)
        except ValueError as ve:
            logging.error(f"Error en el formato del quiz: {str(ve)}")
            return jsonify({"error": f"Error en el formato del quiz: {str(ve)}"}), 500

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {tema}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar el quiz: {str(e)}"}), 500
    
def validate_quiz_format(quiz_data):
    required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema"]
    for key in required_keys:
        if key not in quiz_data:
            raise ValueError(f"Falta la clave {key} en el quiz")
    if not isinstance(quiz_data["opciones"], list) or len(quiz_data["opciones"]) < 2:
        raise ValueError("El quiz debe tener al menos 2 opciones")
    if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
        raise ValueError("La respuesta_correcta debe coincidir exactamente con una de las opciones")
    

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta", "")[:300]).strip().lower()
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", "")[:300]).strip().lower()
        tema = bleach.clean(data.get("tema", "")[:50])

        progreso = cargar_progreso(usuario)
        puntos = progreso["puntos"]
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []

        es_correcta = respuesta == respuesta_correcta
        if es_correcta:
            puntos += 10
            if tema not in temas_aprendidos:
                temas_aprendidos.append(tema)
            mensaje = f"✅ ¡Correcto! Has ganado 10 puntos. Tema: {tema}. ¿Deseas saber más?"
        else:
            mensaje = f"❌ Incorrecto. La respuesta correcta era: {data.get('respuesta_correcta', 'No disponible')}. ¿Deseas saber más?"

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

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())

        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        if not temas_no_aprendidos:
            temas_no_aprendidos = temas_disponibles  # Si no hay temas no aprendidos, usar todos

        contexto = "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            "Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            "Tu tarea es recomendar un tema de Programación Avanzada basado en el historial de interacciones y los temas ya aprendidos. "
            "Elige un tema de los disponibles que no haya sido aprendido, considerando el contexto del historial. "
            "Si no hay temas no aprendidos, elige un tema relevante para reforzar. "
            "Devuelve solo el nombre del tema recomendado (por ejemplo, 'Patrones de diseño') sin explicaciones adicionales."
            f"Contexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_no_aprendidos)}\nTimestamp: {int(time.time())}"
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

        recomendacion = completion.choices[0].message.content.strip()
        if not recomendacion or recomendacion not in temas_disponibles:
            recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)

        logging.info(f"Recomendación para usuario {usuario}: {recomendacion}")
        return jsonify({"recommendation": recomendacion})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        return jsonify({"error": f"Error al generar la recomendación: {str(e)}"}), 500

if __name__ == "__main__":
    init_db()
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))