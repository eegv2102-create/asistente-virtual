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

    # Validar nivel_explicacion
    niveles_validos = ["basica", "ejemplos", "avanzada"]
    if nivel_explicacion not in niveles_validos:
        logging.warning(f"Nivel de explicación inválido: {nivel_explicacion}. Usando 'basica' por defecto.")
        nivel_explicacion = "basica"

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

    # Limitar historial a las últimas 3 interacciones para evitar confusión
    contexto = ""
    if historial:
        contexto = "\nHistorial reciente (referencia, no repitas contenido):\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-3:]])

    # Prompts mejorados para cada nivel
    if nivel_explicacion == "basica":
        estilo_prompt = (
            "Eres un tutor de Programación Avanzada. Explica el concepto preguntado de manera sencilla y clara, como si le hablaras a un principiante sin conocimientos previos. "
            "Proporciona **solo la definición** del concepto en no más de 100 palabras, usando un lenguaje simple y evitando tecnicismos complejos. "
            "**No incluyas ejemplos, ventajas, desventajas, prerrequisitos, preguntas adicionales ni encabezados como 'Ejemplo:' o 'Ventajas:'.** "
            "Si el concepto no está claro, pide al usuario que lo especifique."
        )
        secciones_no_deseadas = [
            r'(?:Ejemplo|Ejemplo de código|Example|Code example):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Ventajas|Advantages|Beneficios):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Desventajas|Disadvantages):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Prerrequisitos|Prerrequisitos recomendados|Prerequisites):[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?|Quieres continuar\?|Anything else\?',
            r'\n\s*\n\s*'
        ]
    elif nivel_explicacion == "ejemplos":
        estilo_prompt = (
            "Eres un tutor de Programación Avanzada. Proporciona la definición del concepto preguntado en no más de 100 palabras, seguida de **un ejemplo de código claro y conciso** en un lenguaje relevante al concepto (por ejemplo, Python, Java, o C++). "
            "El ejemplo debe estar comentado y ser fácil de entender para alguien con conocimientos básicos de programación. "
            "**No incluyas ventajas, desventajas, prerrequisitos, preguntas adicionales ni encabezados como 'Ventajas:' o 'Prerrequisitos:'.** "
            "Formato: <Definición>\n\n**Ejemplo de código**:\n```lenguaje\n<código>\n```"
        )
        secciones_no_deseadas = [
            r'(?:Ventajas|Advantages|Beneficios):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Desventajas|Disadvantages):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Prerrequisitos|Prerrequisitos recomendados|Prerequisites):[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?|Quieres continuar\?|Anything else\?',
            r'\n\s*\n\s*'
        ]
    elif nivel_explicacion == "avanzada":
        estilo_prompt = (
            "Eres un tutor de Programación Avanzada. Proporciona una explicación teórica avanzada del concepto preguntado en no más de 150 palabras, dirigida a alguien con experiencia en programación. "
            "Incluye detalles técnicos profundos, referencias a estándares o especificaciones si aplica, y usa un lenguaje técnico pero claro. "
            "**No incluyas ejemplos, ventajas, desventajas, prerrequisitos, preguntas adicionales ni encabezados como 'Ejemplo:' o 'Ventajas:'.** "
            "Si el concepto no está claro, pide al usuario que lo especifique."
        )
        secciones_no_deseadas = [
            r'(?:Ejemplo|Ejemplo de código|Example|Code example):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Ventajas|Advantages|Beneficios):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Desventajas|Disadvantages):[\s\S]*?(?=(?:^##|\Z))',
            r'(?:Prerrequisitos|Prerrequisitos recomendados|Prerequisites):[\s\S]*?(?=(?:^##|\Z))',
            r'\?Deseas saber más\?|Quieres continuar\?|Anything else\?',
            r'\n\s*\n\s*'
        ]

    prompt = (
        f"{estilo_prompt}\n"
        f"Pregunta del usuario: {pregunta}\n"
        f"Contexto: {contexto}\n"
        f"Tema relacionado (si aplica): {tema_encontrado or 'No identificado'}"
    )

    try:
        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": "Eres un tutor experto en Programación Avanzada. Sigue estrictamente las instrucciones del prompt."},
                {"role": "user", "content": prompt}
            ],
            model="llama3-70b-8192",  # Cambiar a "mixtral-8x7b-32768" si el problema persiste
            max_tokens=500,
            temperature=0.5  # Reducido para mayor precisión
        )
        respuesta = completion.choices[0].message.content.strip()
        # Limpieza adicional para eliminar secciones no deseadas
        for regex in secciones_no_deseadas:
            respuesta = re.sub(regex, '', respuesta, flags=re.MULTILINE | re.IGNORECASE).strip()
        # Asegurar formato para ejemplos
        if nivel_explicacion == "ejemplos" and "```" not in respuesta:
            respuesta += "\n\n**Ejemplo de código**:\n```python\n# Ejemplo no proporcionado por el modelo. Contacta al soporte para más detalles.\n```"
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
        nivel_explicacion = bleach.clean(data.get("nivel_explicacion", "basica")[:20])

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

        logging.info(f"Pregunta de {usuario}: {pregunta} - Nivel: {nivel_explicacion} - Respuesta: {respuesta}")
        return jsonify({"respuesta": respuesta})
    except Exception as e:
        logging.error(f"Error en /ask: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/quiz", methods=["POST"])
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        tema = bleach.clean(data.get("tema", "")[:50])
        tipo_quiz = bleach.clean(data.get("tipo_quiz", "opciones"))

        if tipo_quiz not in ["opciones", "verdadero_falso"]:
            return jsonify({"error": "Tipo de quiz inválido"}), 400

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            f"Genera un quiz de {tipo_quiz} sobre el tema '{tema}' en Programación Avanzada. "
            "Devuelve un JSON con: {'quiz': [{'pregunta': str, 'opciones': list[str], 'respuesta_correcta': str, 'tema': str, 'nivel': str}]} "
            f"Genera 5 preguntas. Para opciones: exactamente 4 opciones, una correcta. Para verdadero_falso: exactamente 2 opciones (Verdadero, Falso)."
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera el quiz."}
            ],
            model="llama3-70b-8192",
            max_tokens=1000,
            temperature=0.5
        )

        try:
            quiz_data = json.loads(completion.choices[0].message.content.strip())
            if not isinstance(quiz_data, dict) or "quiz" not in quiz_data or not isinstance(quiz_data["quiz"], list):
                raise ValueError("Formato de quiz inválido")
            for q in quiz_data["quiz"]:
                if not all(key in q for key in ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]):
                    raise ValueError("Faltan campos requeridos en una pregunta del quiz")
                if tipo_quiz == "opciones" and len(q["opciones"]) != 4:
                    raise ValueError("Cada pregunta de opción múltiple debe tener exactamente 4 opciones")
                if tipo_quiz == "verdadero_falso" and len(q["opciones"]) != 2:
                    raise ValueError("Cada pregunta de verdadero/falso debe tener exactamente 2 opciones")
        except json.JSONDecodeError:
            logging.error("Respuesta de Groq no es un JSON válido")
            return jsonify({"error": "Error al procesar el formato del quiz"}), 500
        except ValueError as ve:
            logging.error(f"Error en el formato del quiz: {str(ve)}")
            return jsonify({"error": f"Error en el formato del quiz: {str(ve)}"}), 500

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {tema}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar el quiz: {str(e)}"}), 500

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta", "")[:300])
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", "")[:300])
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

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())

        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        contexto = "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            "Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            "Tu tarea es recomendar un tema de Programación Avanzada basado en el historial de interacciones y los temas ya aprendidos. "
            "Elige un tema de los disponibles que no haya sido aprendido, considerando el contexto del historial. "
            "Devuelve solo el nombre del tema recomendado (por ejemplo, 'Patrones de diseño') sin explicaciones adicionales."
            f"Contexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_no_aprendidos)}"
        )

        completion = call_groq_api(
            client,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Recomienda un tema."}
            ],
            model="llama3-70b-8192",
            max_tokens=50,
            temperature=0.5
        )

        recomendacion = completion.choices[0].message.content.strip()
        if not recomendacion or recomendacion not in temas_disponibles:
            recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else "Patrones de diseño"

        logging.info(f"Recomendación para usuario {usuario}: {recomendacion}")
        return jsonify({"recommendation": recomendacion})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        return jsonify({"error": f"Error al generar la recomendación: {str(e)}"}), 500

if __name__ == "__main__":
    init_db()
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))