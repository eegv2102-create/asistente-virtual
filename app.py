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

# Configuración de logging
logging.basicConfig(
    filename='app.log',
    level=logging.DEBUG,
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

# Rate limiting
limiter = Limiter(get_remote_address, app=app, default_limits=["5 per minute"])

def init_db():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        # Crear tablas con manejo de errores
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', nivel TEXT DEFAULT 'intermedio', avatar_id TEXT DEFAULT 'default')''')
        c.execute('''CREATE TABLE IF NOT EXISTS aprendizaje
                     (pregunta TEXT PRIMARY KEY, respuesta TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, video_url TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT, animation_url TEXT)''')
        # Insertar avatares predeterminados solo si no existen
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
        # Cargar datos iniciales
        try:
            with open("aprendizaje_inicial.json", "r", encoding="utf-8") as f:
                aprendizaje_inicial = json.load(f)
            for pregunta, respuesta in aprendizaje_inicial.items():
                c.execute("INSERT INTO aprendizaje (pregunta, respuesta) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                          (pregunta.lower(), respuesta))
            conn.commit()
            logging.info("aprendizaje_inicial.json cargado correctamente")
        except FileNotFoundError:
            logging.warning("No se encontró aprendizaje_inicial.json")
        except json.JSONDecodeError as e:
            logging.error(f"Error al parsear aprendizaje_inicial.json: {str(e)}")
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        # No lanzar excepción para permitir que la app continúe
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
    logging.warning("Usando temas por defecto")

# Cargar prerequisitos.json
try:
    with open("prerequisitos.json", "r", encoding="utf-8") as f:
        prerequisitos = json.load(f)
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando prerequisitos.json: {str(e)}")
    prerequisitos = {
        "patrones de diseño": ["poo"],
        "multihilos": ["poo"],
        "mvc": ["poo"],
        "poo": []
    }
    logging.warning("Usando prerequisitos por defecto")

@lru_cache(maxsize=128)
def cargar_aprendizaje():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT pregunta, respuesta FROM aprendizaje")
        aprendizaje = dict(c.fetchall())
        conn.close()
        logging.debug("Aprendizaje cargado desde la base de datos")
        return aprendizaje
    except PsycopgError as e:
        logging.error(f"Error al cargar aprendizaje: {str(e)}")
        return {}

@lru_cache(maxsize=128)
def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, nivel, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        result = {"puntos": row[0] if row else 0, "temas_aprendidos": row[1] if row else "",
                  "nivel": row[2] if row else "intermedio", "avatar_id": row[3] if row else "default"}
        logging.debug(f"Progreso cargado para usuario {usuario}: {result}")
        return result
    except PsycopgError as e:
        logging.error(f"Error al cargar progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "nivel": "intermedio", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, nivel="intermedio", avatar_id="default"):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, nivel, avatar_id) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, nivel = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, nivel, avatar_id, puntos, temas_aprendidos, nivel, avatar_id))
        conn.commit()
        conn.close()
        logging.debug(f"Progreso guardado para usuario {usuario}: puntos={puntos}, nivel={nivel}")
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

def log_interaccion(usuario, pregunta, respuesta, video_url=None):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO logs (usuario, pregunta, respuesta, video_url) VALUES (%s, %s, %s, %s)",
                  (usuario, pregunta, respuesta, video_url))
        conn.commit()
        conn.close()
        logging.debug(f"Interacción registrada: usuario={usuario}, pregunta={pregunta}")
    except PsycopgError as e:
        logging.error(f"Error al registrar log: {str(e)}")

FUZZY_THRESHOLD = 75
MAX_PREGUNTA_LEN = 200
MAX_RESPUESTA_LEN = 500

SINONIMOS = {
    "poo": ["programacion orientada a objetos", "oop", "orientada objetos"],
    "multihilos": ["multithreading", "hilos", "threads", "concurrencia"],
    "patrones de diseño": ["design patterns", "patrones", "patrones diseño"],
    "mvc": ["modelo vista controlador", "model view controller", "arquitectura mvc"]
}

def expandir_pregunta(pregunta):
    palabras = pregunta.lower().split()
    expandida = []
    for palabra in palabras:
        for clave, sinonimos in SINONIMOS.items():
            if palabra in sinonimos:
                expandida.append(clave)
                break
        else:
            expandida.append(palabra)
    return " ".join(expandida)

def consultar_groq_api(pregunta, nivel, temas_aprendidos):
    try:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            logging.error("GROQ_API_KEY no configurado")
            return "Error: Falta la clave de API de Groq."
        cache_file = "cache.json"
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cache = json.load(f)
            if pregunta in cache:
                return cache[pregunta]
        except FileNotFoundError:
            cache = {}
        client = Groq(api_key=api_key)
        prompt = f"Eres un tutor de programación en español para estudiantes de Telemática. El usuario está en nivel {nivel} y ha aprendido {temas_aprendidos or 'nada aún'}. Responde a: {pregunta} con una explicación breve y un ejemplo en Java si aplica. Proporciona una respuesta clara y educativa."
        for _ in range(2):
            try:
                completion = client.chat.completions.create(
                    model="llama3-8b-8192",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=256,  # Reducido para Render
                    temperature=0.7,
                    stream=False
                )
                respuesta = completion.choices[0].message.content.strip()[:MAX_RESPUESTA_LEN]
                cache[pregunta] = respuesta
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(cache, f)
                return respuesta
            except Exception as e:
                logging.error(f"Intento fallido en Groq: {str(e)}")
                time.sleep(1)
        return "Error: No se pudo conectar a Groq."
    except Exception as e:
        logging.error(f"Error en Groq: {str(e)}")
        return f"Error al consultar la API: {str(e)}."

def buscar_respuesta_app(pregunta, usuario):
    try:
        logging.debug(f"Procesando pregunta: {pregunta}, usuario: {usuario}")
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        intent = classify_intent(pregunta)
        aprendizaje = cargar_aprendizaje()

        if intent == "saludo":
            return aprendizaje.get(pregunta.lower(), "¡Hola! ¿Qué quieres aprender sobre Programación Avanzada?")
        elif intent == "cambiar_nivel":
            nuevo_nivel = "basico" if "basico" in pregunta else "intermedio" if "intermedio" in pregunta else "avanzado"
            guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nuevo_nivel, progreso["avatar_id"])
            return f"Nivel cambiado a {nuevo_nivel}. ¿Qué tema quieres explorar?"
        elif intent == "quiz":
            quiz_data = quiz().get_json()
            return quiz_data["pregunta"] + " Opciones: " + ", ".join(quiz_data["opciones"])

        expandida = expandir_pregunta(normalize(pregunta))
        hits = buscar_respuesta(expandida, k=3)
        if hits and hits[0][2] > 0.5:
            tema, fragmento, _ = hits[0]
            if prerequisitos.get(tema) and any(cargar_dominio(usuario, prereq) < 0.6 for prereq in prerequisitos[tema]):
                return f"Primero domina: {', '.join(prerequisitos[tema])}. ¿Quieres empezar con ellos?"
            if nivel == "basico":
                respuesta = f"[Básico] {fragmento.split('.')[0]}. Ejemplo en Java: class Ejemplo {{}} ¿Quieres un quiz?"
            elif nivel == "intermedio":
                respuesta = f"[Intermedio] {fragmento}. Ejemplo: class Ejemplo {{ void metodo() {{}} }} ¿Quieres un ejercicio?"
            else:
                respuesta = f"[Avanzado] {fragmento}. Pitfalls: sobrecarga. Ref: oracle.com/java. ¿Quieres un caso real?"
            log_interaccion(usuario, pregunta, respuesta)
            actualizar_dominio(usuario, tema, 0.1)
            return respuesta

        match = process.extractOne(expandida, aprendizaje.keys())
        if match and match[1] >= FUZZY_THRESHOLD:
            return aprendizaje[match[0]]
        
        respuesta = consultar_groq_api(pregunta, nivel, progreso["temas_aprendidos"])
        log_interaccion(usuario, pregunta, respuesta)
        return respuesta + " ¿Quieres un quiz o más detalles?"
    except Exception as e:
        logging.error(f"Error en buscar_respuesta_app: {str(e)}")
        return f"Error al procesar la pregunta: {str(e)}"

def actualizar_dominio(usuario, tema, delta):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso_tema (usuario, tema, dominio, aciertos, fallos) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario, tema) DO UPDATE SET dominio = GREATEST(progreso_tema.dominio + %s, 0), "
                  "aciertos = progreso_tema.aciertos + %s, fallos = progreso_tema.fallos + %s, "
                  "ultima_interaccion = CURRENT_TIMESTAMP",
                  (usuario, tema, delta, 1 if delta > 0 else 0, 1 if delta < 0 else 0, delta, 1 if delta > 0 else 0, 1 if delta < 0 else 0))
        conn.commit()
        conn.close()
        logging.debug(f"Dominio actualizado: usuario={usuario}, tema={tema}, delta={delta}")
    except PsycopgError as e:
        logging.error(f"Error al actualizar dominio: {str(e)}")

def cargar_dominio(usuario, tema):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT dominio FROM progreso_tema WHERE usuario = %s AND tema = %s", (usuario, tema))
        row = c.fetchone()
        conn.close()
        return row[0] if row else 0.0
    except PsycopgError as e:
        logging.error(f"Error al cargar dominio: {str(e)}")
        return 0.0

def recomendar_tema(usuario):
    try:
        dominios = {tema: cargar_dominio(usuario, tema) for tema in temas.keys()}
        if not dominios:
            return random.choice(list(temas.keys()))
        tema_bajo = min(dominios, key=dominios.get)
        if prerequisitos.get(tema_bajo) and any(cargar_dominio(usuario, prereq) < 0.6 for prereq in prerequisitos[tema_bajo]):
            return prerequisitos[tema_bajo][0]
        return tema_bajo
    except Exception as e:
        logging.error(f"Error en recomendar_tema: {str(e)}")
        return random.choice(list(temas.keys()))

@app.route('/')
def index():
    return render_template('index.html')

@app.route("/respuesta", methods=["POST"])
@limiter.limit("5 per minute")
def respuesta():
    try:
        data = request.get_json()
        if not data or "pregunta" not in data:
            return jsonify({"error": "No se proporcionó una pregunta"}), 400
        pregunta = bleach.clean(data.get("pregunta", "").strip().lower()[:MAX_PREGUNTA_LEN])
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        avatar_id = bleach.clean(data.get("avatar_id", "default")[:50])
        
        if not pregunta:
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        progreso = cargar_progreso(usuario)
        respuesta_text = buscar_respuesta_app(pregunta, usuario)
        # Manejo de avatar con respaldo
        avatar = None
        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"))
            c = conn.cursor()
            c.execute("SELECT url, animation_url FROM avatars WHERE avatar_id = %s", (avatar_id,))
            avatar = c.fetchone()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al consultar tabla avatars: {str(e)}")
            # Forzar inicialización de la base de datos
            if "relation \"avatars\" does not exist" in str(e).lower():
                if init_db():
                    try:
                        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
                        c = conn.cursor()
                        c.execute("SELECT url, animation_url FROM avatars WHERE avatar_id = %s", (avatar_id,))
                        avatar = c.fetchone()
                        conn.close()
                    except PsycopgError as e2:
                        logging.error(f"Reintento fallido al consultar avatars: {str(e2)}")
        
        response_data = {
            "respuesta": respuesta_text,
            "avatar_url": avatar[0] if avatar else "/static/img/default-avatar.png",
            "animation_url": avatar[1] if avatar else "/static/animations/default.json"
        }
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"Error en /respuesta: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/aprendizaje", methods=["POST"])
@limiter.limit("5 per minute")
def aprendizaje():
    try:
        data = request.get_json()
        pregunta = bleach.clean(data.get("pregunta", "").strip().lower()[:MAX_PREGUNTA_LEN])
        respuesta = bleach.clean(data.get("respuesta", "").strip()[:MAX_RESPUESTA_LEN])
        
        if not pregunta or not respuesta:
            return jsonify({"error": "Pregunta y respuesta no pueden estar vacías"}), 400
            
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO aprendizaje (pregunta, respuesta) VALUES (%s, %s) ON CONFLICT (pregunta) DO UPDATE SET respuesta = %s",
                  (pregunta, respuesta, respuesta))
        conn.commit()
        conn.close()
        cargar_aprendizaje.cache_clear()
        return jsonify({"mensaje": "¡Aprendido con éxito!"})
    except PsycopgError as e:
        logging.error(f"Error en /aprendizaje: {str(e)}")
        return jsonify({"error": f"Error al aprender: {str(e)}"}), 500

@app.route("/progreso", methods=["GET"])
def progreso():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        progreso_data = cargar_progreso(usuario)
        return jsonify(progreso_data)
    except Exception as e:
        logging.error(f"Error en /progreso: {str(e)}")
        return jsonify({"error": f"Error al cargar el progreso: {str(e)}"}), 500

@app.route("/actualizar_nivel", methods=["POST"])
def actualizar_nivel():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        nivel = bleach.clean(data.get("nivel", "intermedio")[:20])
        
        if nivel not in ["basico", "intermedio", "avanzado"]:
            return jsonify({"error": "Nivel inválido"}), 400
            
        progreso = cargar_progreso(usuario)
        guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nivel, progreso["avatar_id"])
        return jsonify({"mensaje": f"Nivel actualizado a {nivel}"})
    except Exception as e:
        logging.error(f"Error en /actualizar_nivel: {str(e)}")
        return jsonify({"error": f"Error al actualizar el nivel: {str(e)}"}), 500

@app.route("/avatars", methods=["GET"])
def avatars():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        avatars = [{"avatar_id": row[0], "nombre": row[1], "url": row[2], "animation_url": row[3]} for row in c.fetchall()]
        conn.close()
        return jsonify(avatars if avatars else [
            {"avatar_id": "default", "nombre": "Avatar Predeterminado", "url": "/static/img/default-avatar.png", "animation_url": "/static/animations/default.json"},
            {"avatar_id": "poo", "nombre": "POO Avatar", "url": "/static/img/poo.png", "animation_url": "/static/animations/poo.json"}
        ])
    except PsycopgError as e:
        logging.error(f"Error al obtener avatares: {str(e)}")
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
        dificultad = "facil" if progreso["nivel"] == "basico" else "medio" if progreso["nivel"] == "intermedio" else "dificil"
        pregunta = f"¿Qué describe mejor {tema} en nivel {dificultad}?"
        opciones = [temas[tema].split('.')[0]]
        opciones.extend(random.sample([temas[t].split('.')[0] for t in temas if t != tema], 2))
        random.shuffle(opciones)
        return jsonify({"pregunta": pregunta, "opciones": opciones, "respuesta_correcta": temas[tema].split('.')[0], "tema": tema})
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
        delta_dominio = 0.1 if es_correcta else -0.05
        actualizar_dominio(usuario, tema, delta_dominio)
        if es_correcta:
            puntos = 20 if progreso["nivel"] == "avanzado" else 10
            nuevos_puntos = progreso["puntos"] + puntos
            temas_aprendidos = progreso["temas_aprendidos"]
            if tema not in temas_aprendidos.split(","):
                temas_aprendidos += ("," if temas_aprendidos else "") + tema
            guardar_progreso(usuario, nuevos_puntos, temas_aprendidos, progreso["nivel"], progreso["avatar_id"])
            mensaje = f"¡Correcto! Ganaste {puntos} puntos. {temas[tema]} ¿Otro quiz?"
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
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("0.0.0.0", 5000))
        sock.close()
        webbrowser.open("http://localhost:5000")
    except OSError:
        logging.warning("Puerto 5000 en uso.")
    app.run(debug=True, host='0.0.0.0', port=5000)