# app.py (Modificado: Eliminadas referencias a prerequisitos.json y funciones relacionadas. Eliminada ruta /aprender y cualquier código de modo aprendizaje. Modificado /preguntar para usar Groq con prompts diferenciados por nivel, incluyendo ejemplos de código y estilo de enseñanza. Agregado mensaje de bienvenida al cargar progreso. Ajustes menores para consistencia.)
import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify
from fuzzywuzzy import process
from functools import lru_cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from gtts import gTTS
import io
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError
import httpx
import bleach

# Cargar variables de entorno
load_dotenv()

app = Flask(__name__)

# Configuración de logging optimizada para Render
logging.basicConfig(
    filename='app.log',
    level=logging.INFO,  # Reducido a INFO para menos ruido en logs
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Funciones de respaldo para nlp.py
try:
    from nlp import buscar_respuesta, classify_intent, normalize
except ImportError as e:
    logging.error(f"No se pudo importar nlp.py: {str(e)}")
    def buscar_respuesta(pregunta, k=3):
        logging.warning("Usando buscar_respuesta de respaldo")
        return []
    def classify_intent(pregunta):
        logging.warning("Usando classify_intent de respaldo")
        if any(word in pregunta.lower() for word in ["hola", "saludos"]):
            return "saludo"
        if any(word in pregunta.lower() for word in ["nivel", "cambiar nivel"]):
            return "cambiar_nivel"
        if "quiz" in pregunta.lower():
            return "quiz"
        return "definicion"
    def normalize(pregunta):
        logging.warning("Usando normalize de respaldo")
        return pregunta.lower()

# Rate limiting ajustado para Render
limiter = Limiter(get_remote_address, app=app, default_limits=["10 per minute"])  # Aumentado para mayor flexibilidad

def init_db():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        # Cambiar nivel predeterminado a 'basico'
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', nivel TEXT DEFAULT 'basico', avatar_id TEXT DEFAULT 'default')''')
        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, video_url TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT, animation_url TEXT)''')
        c.execute("INSERT INTO avatars (avatar_id, nombre, url, animation_url) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png", "/static/animations/default.json"))
        c.execute("INSERT INTO avatars (avatar_id, nombre, url, animation_url) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                  ("poo", "POO Avatar", "/static/img/poo.png", "/static/animations/poo.json"))
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        c.execute('''CREATE TABLE IF NOT EXISTS progreso_tema
                     (usuario TEXT, tema TEXT, dominio REAL DEFAULT 0.0, aciertos INTEGER DEFAULT 0, fallos INTEGER DEFAULT 0, ultima_interaccion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                     PRIMARY KEY (usuario, tema))''')
        conn.commit()
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    return True

# Cargar temas.json
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {
        "poo": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento.",
        "patrones de diseño": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software.",
        "multihilos": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento.",
        "mvc": "El patrón MVC separa la lógica de negocio, la interfaz de usuario y el control en tres componentes interconectados."
    }

# Cliente Groq
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

def recomendar_tema(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT tema, dominio FROM progreso_tema WHERE usuario = %s ORDER BY dominio ASC LIMIT 1", (usuario,))
        row = c.fetchone()
        conn.close()
        if row:
            return row[0]
        return random.choice(list(temas.keys()))
    except PsycopgError as e:
        logging.error(f"Error recomendando tema: {str(e)}")
        return random.choice(list(temas.keys()))

def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, nivel, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        if row:
            return {"puntos": row[0], "temas_aprendidos": row[1], "nivel": row[2], "avatar_id": row[3]}
        else:
            return {"puntos": 0, "temas_aprendidos": "", "nivel": "basico", "avatar_id": "default"}
    except PsycopgError as e:
        logging.error(f"Error cargando progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "nivel": "basico", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, nivel, avatar_id):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, nivel, avatar_id) VALUES (%s, %s, %s, %s, %s) ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, nivel = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, nivel, avatar_id, puntos, temas_aprendidos, nivel, avatar_id))
        conn.commit()
        conn.close()
    except PsycopgError as e:
        logging.error(f"Error guardando progreso: {str(e)}")

def actualizar_dominio(usuario, tema, delta_dominio):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso_tema (usuario, tema, dominio) VALUES (%s, %s, %s) ON CONFLICT (usuario, tema) DO UPDATE SET dominio = progreso_tema.dominio + %s, ultima_interaccion = CURRENT_TIMESTAMP",
                  (usuario, tema, delta_dominio, delta_dominio))
        conn.commit()
        conn.close()
    except PsycopgError as e:
        logging.error(f"Error actualizando dominio: {str(e)}")

def log_interaccion(usuario, pregunta, respuesta, video_url=None):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO logs (usuario, pregunta, respuesta, video_url) VALUES (%s, %s, %s, %s)",
                  (usuario, pregunta, respuesta, video_url))
        conn.commit()
        conn.close()
    except PsycopgError as e:
        logging.error(f"Error loggeando interacción: {str(e)}")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/preguntar", methods=["POST"])
@limiter.limit("10 per minute")
def preguntar():
    try:
        data = request.get_json()
        if not data or "pregunta" not in data:
            return jsonify({"error": "Faltan datos en la solicitud"}), 400
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        pregunta = bleach.clean(data.get("pregunta").strip()[:500])
        if not pregunta:
            return jsonify({"error": "Pregunta vacía"}), 400
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        intent = classify_intent(pregunta)
        if intent == "cambiar_nivel":
            nuevo_nivel = "intermedio" if "intermedio" in pregunta.lower() else "avanzado" if "avanzado" in pregunta.lower() else "basico"
            guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nuevo_nivel, progreso["avatar_id"])
            respuesta = f"Nivel cambiado a {nuevo_nivel.capitalize()}. ¿Qué más quieres aprender?"
            log_interaccion(usuario, pregunta, respuesta)
            return jsonify({"respuesta": respuesta, "video_url": None})
        elif intent == "saludo":
            respuesta = "¡Hola! Bienvenido al asistente de programación avanzada. ¿En qué nivel quieres aprender hoy? (Básico, Intermedio, Avanzado)"
            log_interaccion(usuario, pregunta, respuesta)
            return jsonify({"respuesta": respuesta, "video_url": None})
        # Búsqueda en temas.json con TF-IDF
        results = buscar_respuesta(pregunta, nivel=nivel)
        if results:
            tema, contenido, score = results[0]
            respuesta = f"Respuesta encontrada en temas ({nivel}): {contenido}"
        else:
            # Usar Groq con prompt diferenciado por nivel
            prompt_base = "Eres un profesor experto en programación avanzada. Explica el concepto de manera clara y educativa."
            if nivel == "basico":
                prompt = f"{prompt_base} Usa lenguaje simple, evita jerga técnica. Proporciona un ejemplo de código básico en Java o Python. Pregunta: {pregunta}"
            elif nivel == "intermedio":
                prompt = f"{prompt_base} Incluye detalles intermedios, como implementaciones prácticas. Proporciona un ejemplo de código intermedio con explicaciones. Pregunta: {pregunta}"
            else:  # avanzado
                prompt = f"{prompt_base} Discute conceptos avanzados, optimizaciones y mejores prácticas. Proporciona un ejemplo de código avanzado con análisis. Pregunta: {pregunta}"
            completion = groq_client.chat.completions.create(
                messages=[{"role": "user", "content": prompt}],
                model="llama3-70b-8192",
                temperature=0.7,
                max_tokens=500
            )
            respuesta = completion.choices[0].message.content.strip()
        log_interaccion(usuario, pregunta, respuesta)
        return jsonify({"respuesta": respuesta, "video_url": None})
    except Exception as e:
        logging.error(f"Error en /preguntar: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/progreso", methods=["GET"])
def progreso():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        progreso = cargar_progreso(usuario)
        # Mensaje de bienvenida al cargar
        if progreso["puntos"] == 0:
            bienvenida = "¡Bienvenido! Soy tu asistente de programación avanzada. Empieza preguntando sobre un tema."
            log_interaccion(usuario, "inicio", bienvenida)
            return jsonify({"progreso": progreso, "bienvenida": bienvenida})
        return jsonify({"progreso": progreso})
    except Exception as e:
        logging.error(f"Error en /progreso: {str(e)}")
        return jsonify({"error": f"Error al cargar progreso: {str(e)}"}), 500

@app.route("/cambiar_nivel", methods=["POST"])
def cambiar_nivel():
    try:
        data = request.get_json()
        if not data or "nivel" not in data:
            return jsonify({"error": "Faltan datos en la solicitud"}), 400
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        nivel = bleach.clean(data.get("nivel").strip()[:20])
        if nivel not in ["basico", "intermedio", "avanzado"]:
            return jsonify({"error": "Nivel inválido"}), 400
        progreso = cargar_progreso(usuario)
        guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nivel, progreso["avatar_id"])
        return jsonify({"mensaje": f"Nivel cambiado a {nivel.capitalize()}"})
    except Exception as e:
        logging.error(f"Error en /cambiar_nivel: {str(e)}")
        return jsonify({"error": f"Error al cambiar nivel: {str(e)}"}), 500

@app.route("/avatars", methods=["GET"])
def avatars():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        data = c.fetchall()
        conn.close()
        return jsonify([
            {"avatar_id": row[0], "nombre": row[1], "url": row[2], "animation_url": row[3]}
            for row in data
        ])
    except PsycopgError as e:
        logging.error(f"Error en /avatars: {str(e)}")
        return jsonify([
            {"avatar_id": "default", "nombre": "Avatar Predeterminado", "url": "/static/img/default-avatar.png", "animation_url": "/static/animations/default.json"},
            {"avatar_id": "poo", "nombre": "POO Avatar", "url": "/static/img/poo.png", "animation_url": "/static/animations/poo.json"}
        ])

@app.route("/quiz", methods=["GET"])
def quiz():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        tema = recomendar_tema(usuario)
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        dificultad = "facil" if nivel == "basico" else "medio" if nivel == "intermedio" else "dificil"
        # Usar temas.json por nivel
        base_pregunta = temas.get(tema, {}).get(nivel, temas[tema].split('.')[0])
        pregunta = f"¿Qué describe mejor {tema} en nivel {dificultad}?"
        opciones = [base_pregunta.split('.')[0]]
        opciones.extend(random.sample([temas[t].get(nivel, temas[t].split('.')[0]).split('.')[0] for t in temas if t != tema], 2))
        random.shuffle(opciones)
        return jsonify({"pregunta": pregunta, "opciones": opciones, "respuesta_correcta": base_pregunta.split('.')[0], "tema": tema})
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar el quiz: {str(e)}"}), 500

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        if not data or "respuesta" not in data or "respuesta_correcta" not in data or "tema" not in data:
            return jsonify({"error": "Faltan datos en la solicitud"}), 400
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta").strip()[:200])
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta").strip()[:200])
        tema = bleach.clean(data.get("tema").strip()[:50])
        progreso = cargar_progreso(usuario)
        es_correcta = respuesta == respuesta_correcta
        puntos = 10 if progreso["nivel"] == "basico" else 15 if progreso["nivel"] == "intermedio" else 20
        delta_dominio = 0.15 if es_correcta else -0.05
        actualizar_dominio(usuario, tema, delta_dominio)
        if es_correcta:
            nuevos_puntos = progreso["puntos"] + puntos
            temas_aprendidos = progreso["temas_aprendidos"]
            if tema not in temas_aprendidos.split(","):
                temas_aprendidos += ("," if temas_aprendidos else "") + tema
            guardar_progreso(usuario, nuevos_puntos, temas_aprendidos, progreso["nivel"], progreso["avatar_id"])
            mensaje = f"¡Correcto! Ganaste {puntos} puntos. {temas.get(tema, {}).get(progreso['nivel'], temas[tema])} ¿Otro quiz?"
        else:
            mensaje = f"Incorrecto. Respuesta correcta: {respuesta_correcta}. ¿Intentar de nuevo?"
        log_interaccion(usuario, f"Quiz sobre {tema}", mensaje)
        return jsonify({"respuesta": mensaje, "es_correcta": es_correcta})
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error al procesar la respuesta: {str(e)}"}), 500

@app.route("/recomendacion", methods=["GET"])
def recomendacion():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        recomendacion_tema = recomendar_tema(usuario)
        return jsonify({"recomendacion": recomendacion_tema})
    except Exception as e:
        logging.error(f"Error en /recomendacion: {str(e)}")
        return jsonify({"error": f"Error al recomendar tema: {str(e)}"}), 500

@app.route("/analytics", methods=["GET"])
def analytics():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT tema, dominio, aciertos, fallos FROM progreso_tema WHERE usuario = %s", (usuario,))
        data = c.fetchall()
        conn.close()
        result = [
            {
                "tema": row[0],
                "dominio": float(row[1]),
                "tasa_acierto": float(row[2] / (row[2] + row[3] or 1))
            } for row in data
        ]
        return jsonify(result)
    except PsycopgError as e:
        logging.error(f"Error en /analytics: {str(e)}")
        return jsonify([])

@app.route("/tts", methods=["POST"])
def tts():
    try:
        data = request.get_json()
        text = bleach.clean(data.get("text", "").strip()[:300])
        if not text:
            return jsonify({"error": "Texto vacío"}), 400
        tts = gTTS(text=text, lang='es')
        audio_buffer = io.BytesIO()
        tts.write_to_fp(audio_buffer)
        audio_buffer.seek(0)
        return audio_buffer.read(), 200, {'Content-Type': 'audio/mp3'}
    except Exception as e:
        logging.error(f"Error en /tts: {str(e)}")
        return jsonify({"error": f"Error al generar audio: {str(e)}"}), 500

if __name__ == "__main__":
    init_db()
    # Deshabilitar webbrowser.open en Render (solo para desarrollo local)
    if os.getenv("RENDER", "false").lower() != "true":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("0.0.0.0", 5000))
            sock.close()
            webbrowser.open("http://localhost:5000")
        except OSError:
            logging.warning("Puerto 5000 en uso.")
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))  # Ajuste para Render