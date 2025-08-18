import time
import json
import os
import random
import logging
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
import traceback
from nlp import buscar_respuesta, classify_intent, normalize

# Cargar variables de entorno
load_dotenv()

app = Flask(__name__)

# Configuración de logging optimizada para Render
logging.basicConfig(
    filename='app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Rate limiting ajustado
limiter = Limiter(get_remote_address, app=app, default_limits=["50 per minute"])

def init_db():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
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

try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {
        "poo": {
            "basico": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento.\n**Ejemplo**: Un objeto 'Coche' tiene propiedades como 'color' y métodos como 'acelerar'.",
            "intermedio": "La programación orientada a objetos utiliza clases para definir objetos con atributos y métodos, implementando conceptos como herencia y polimorfismo.\n**Ejemplo**: ```python\nclass Coche:\n    def __init__(self, color):\n        self.color = color\n    def acelerar(self):\n        return f'El coche {self.color} acelera.'\nclass Deportivo(Coche):\n    def acelerar(self):\n        return f'El coche {self.color} acelera rápido!'\n```",
            "avanzado": "La programación orientada a objetos permite diseños modulares usando encapsulación, herencia, polimorfismo y abstracción, optimizando la mantenibilidad y escalabilidad.\n**Ejemplo**: Un sistema de gestión de vehículos con interfaces y clases abstractas:\n```python\nfrom abc import ABC, abstractmethod\nclass Vehiculo(ABC):\n    @abstractmethod\n    def acelerar(self):\n        pass\nclass Coche(Vehiculo):\n    def __init__(self, color):\n        self.color = color\n    def acelerar(self):\n        return f'Coche {self.color} acelera.'\n```"
        },
        "patrones de diseño": {
            "basico": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software.\n**Ejemplo**: El patrón Singleton asegura que una clase tenga una sola instancia.",
            "intermedio": "Los patrones de diseño, como Singleton o Factory, resuelven problemas específicos de diseño.\n**Ejemplo**: Implementación de Singleton:\n```python\nclass Singleton:\n    _instance = None\n    def __new__(cls):\n        if cls._instance is None:\n            cls._instance = super().__new__(cls)\n        return cls._instance\n```",
            "avanzado": "Los patrones de diseño, como Observer o Strategy, permiten sistemas flexibles y mantenibles.\n**Ejemplo**: Patrón Observer para notificaciones:\n```python\nclass Sujeto:\n    def __init__(self):\n        self._observadores = []\n    def agregar(self, observador):\n        self._observadores.append(observador)\n    def notificar(self):\n        for obs in self._observadores:\n            obs.actualizar()\n```"
        },
        "multihilos": {
            "basico": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento.\n**Ejemplo**: Correr dos tareas al mismo tiempo, como descargar archivos.",
            "intermedio": "El multihilo usa hilos para tareas concurrentes, manejando sincronización.\n**Ejemplo**: Uso de hilos en Python:\n```python\nimport threading\ndef tarea():\n    print('Tarea en ejecución')\nt = threading.Thread(target=tarea)\nt.start()\n```",
            "avanzado": "El multihilo maneja concurrencia con sincronización avanzada como cerrojos y colas.\n**Ejemplo**: Cola para tareas concurrentes:\n```python\nfrom queue import Queue\nimport threading\nq = Queue()\ndef trabajador():\n    while True:\n        item = q.get()\n        print(f'Procesando {item}')\n        q.task_done()\nt = threading.Thread(target=trabajador)\nt.start()\nq.put('Tarea 1')\n```"
        },
        "mvc": {
            "basico": "El patrón MVC separa la lógica de negocio, la interfaz de usuario y el control.\n**Ejemplo**: Una app web donde el modelo guarda datos, la vista los muestra y el controlador los gestiona.",
            "intermedio": "MVC organiza aplicaciones separando modelo, vista y controlador.\n**Ejemplo**: Estructura MVC simple:\n```python\nclass Modelo:\n    def __init__(self):\n        self.datos = 'Datos'\nclass Vista:\n    def mostrar(self, datos):\n        print(datos)\nclass Controlador:\n    def __init__(self, modelo, vista):\n        self.modelo = modelo\n        self.vista = vista\n    def actualizar(self):\n        self.vista.mostrar(self.modelo.datos)\n```",
            "avanzado": "MVC permite aplicaciones escalables con separación clara de responsabilidades.\n**Ejemplo**: MVC con eventos:\n```python\nclass Modelo:\n    def __init__(self):\n        self.datos = 'Datos'\n        self.observadores = []\n    def actualizar_datos(self, datos):\n        self.datos = datos\n        for obs in self.observadores:\n            obs.actualizar(self.datos)\nclass Vista:\n    def actualizar(self, datos):\n        print(f'Vista actualizada: {datos}')\nclass Controlador:\n    def __init__(self, modelo, vista):\n        self.modelo = modelo\n        self.vista = vista\n        self.modelo.observadores.append(self.vista)\n    def actualizar(self, datos):\n        self.modelo.actualizar_datos(datos)\n```"
        }
    }
    logging.warning("Usando temas por defecto")

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
def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, nivel, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        if row:
            return {"puntos": row[0], "temas_aprendidos": row[1], "nivel": row[2], "avatar_id": row[3]}
        return {"puntos": 0, "temas_aprendidos": "", "nivel": "basico", "avatar_id": "default"}
    except PsycopgError as e:
        logging.error(f"Error al cargar progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "nivel": "basico", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, nivel="basico", avatar_id="default"):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, nivel, avatar_id) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, nivel = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, nivel, avatar_id, puntos, temas_aprendidos, nivel, avatar_id))
        conn.commit()
        conn.close()
        logging.info(f"Progreso guardado para usuario {usuario}: puntos={puntos}, nivel={nivel}")
    except PsycopgError as e:
        logging.error(f"Error guardando progreso: {str(e)}")

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
        logging.error(f"Error logging interaccion: {str(e)}")

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

def consultar_groq_api(pregunta, nivel, temas_aprendidos, tema=None):
    try:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            logging.error("GROQ_API_KEY no configurado")
            return "Error: Configura la clave de API de Groq."
        cache_file = "cache.json"
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cache = json.load(f)
            cache_key = f"{pregunta}_{nivel}_{tema or 'general'}"
            if cache_key in cache:
                logging.debug(f"Respuesta obtenida de caché para {cache_key}")
                return cache[cache_key]
        except FileNotFoundError:
            cache = {}
        client = Groq(api_key=api_key)
        system_prompt = f"Eres un asistente educativo especializado en programación. Responde en español, en nivel {nivel} (básico: explicaciones simples con ejemplos básicos; intermedio: explicaciones con ejemplos de código; avanzado: explicaciones técnicas con ejemplos complejos y aplicaciones reales). Considera que el usuario ha aprendido: {temas_aprendidos or 'nada'}. "
        if tema:
            system_prompt += f"Enfócate en el tema '{tema}'. "
        system_prompt += "Proporciona ejemplos claros y relevantes según el nivel. Responde de forma clara, concisa y educativa."
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": pregunta}
        ]
        response = client.chat.completions.create(
            model="llama3-8b-8192",
            messages=messages,
            max_tokens=300,
            temperature=0.7
        )
        respuesta = response.choices[0].message.content.strip()
        cache[cache_key] = respuesta
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logging.error(f"Error al guardar caché: {str(e)}")
        return respuesta
    except Exception as e:
        logging.error(f"Error en Groq API: {str(e)}\n{traceback.format_exc()}")
        return f"Error al consultar la API de Groq: {str(e)}. Intenta de nuevo."

def recomendar_tema(usuario):
    progreso = cargar_progreso(usuario)
    temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
    temas_disponibles = [tema for tema in temas.keys() if tema not in temas_aprendidos]
    if not temas_disponibles:
        return random.choice(list(temas.keys()))
    for tema in temas_disponibles:
        prereqs = prerequisitos.get(tema, [])
        if all(prereq in temas_aprendidos for prereq in prereqs):
            return tema
    return random.choice(temas_disponibles)

def actualizar_dominio(usuario, tema, delta_dominio):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso_tema (usuario, tema, dominio, aciertos, fallos) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario, tema) DO UPDATE SET dominio = GREATEST(0, LEAST(progreso_tema.dominio + %s, 1)), "
                  "aciertos = progreso_tema.aciertos + %s, fallos = progreso_tema.fallos + %s, "
                  "ultima_interaccion = CURRENT_TIMESTAMP",
                  (usuario, tema, delta_dominio if delta_dominio > 0 else 0, 1 if delta_dominio > 0 else 0, 0 if delta_dominio > 0 else 1, delta_dominio, 1 if delta_dominio > 0 else 0, 0 if delta_dominio > 0 else 1))
        conn.commit()
        conn.close()
    except PsycopgError as e:
        logging.error(f"Error actualizando dominio: {str(e)}")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/respuesta", methods=["POST"])
@limiter.limit("50 per minute")
def respuesta():
    try:
        data = request.get_json()
        pregunta = bleach.clean(data.get("pregunta", "").strip().lower()[:MAX_PREGUNTA_LEN])
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        avatar_id = bleach.clean(data.get("avatar_id", "default")[:50])
        tema = bleach.clean(data.get("tema", "")[:50])
        if not pregunta:
            return jsonify({"error": "Pregunta vacía"}), 400
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        temas_aprendidos = progreso["temas_aprendidos"]
        pregunta_normalizada = normalize(pregunta)
        intent = classify_intent(pregunta_normalizada)
        respuesta_text = ""
        video_url = None
        if intent == "saludo":
            respuesta_text = "¡Hola! ¿En qué te puedo ayudar hoy con tu aprendizaje de programación?"
        elif intent == "cambiar_nivel":
            nivel_nuevo = "intermedio" if nivel == "basico" else "avanzado" if nivel == "intermedio" else "basico"
            guardar_progreso(usuario, progreso["puntos"], temas_aprendidos, nivel_nuevo, avatar_id)
            respuesta_text = f"Nivel cambiado a {nivel_nuevo}. Ahora recibirás explicaciones y ejemplos acordes a este nivel."
        else:
            matches = buscar_respuesta(pregunta_normalizada, k=3, nivel=nivel)
            if matches and matches[0][2] > (0.2 if nivel == "basico" else 0.4 if nivel == "intermedio" else 0.6):
                respuesta_text = matches[0][1]
            else:
                respuesta_text = temas.get(tema, {}).get(nivel) or consultar_groq_api(pregunta_normalizada, nivel, temas_aprendidos, tema)
        log_interaccion(usuario, pregunta, respuesta_text, video_url)
        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"))
            c = conn.cursor()
            c.execute("SELECT url, animation_url FROM avatars WHERE avatar_id = %s", (avatar_id,))
            avatar = c.fetchone()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al consultar tabla avatars: {str(e)}")
            if "relation \"avatars\" does not exist" in str(e).lower():
                if init_db():
                    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
                    c = conn.cursor()
                    c.execute("SELECT url, animation_url FROM avatars WHERE avatar_id = %s", (avatar_id,))
                    avatar = c.fetchone()
                    conn.close()
        response_data = {
            "respuesta": respuesta_text,
            "avatar_url": avatar[0] if avatar else "/static/img/default-avatar.png",
            "animation_url": avatar[1] if avatar else "/static/animations/default.json"
        }
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"Error en /respuesta: {str(e)}\n{traceback.format_exc()}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

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
        nivel = bleach.clean(data.get("nivel", "basico")[:20])
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
        tema = bleach.clean(request.args.get("tema", recomendar_tema(usuario))[:50])
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        dificultad = "fácil" if nivel == "basico" else "medio" if nivel == "intermedio" else "difícil"
        base_pregunta = temas.get(tema, {}).get(nivel, temas[tema]["basico"]).split('\n')[0]
        pregunta = f"¿Qué describe mejor {tema} en nivel {dificultad}?"
        opciones = [base_pregunta]
        otras_opciones = [temas[t].get(nivel, temas[t]["basico"]).split('\n')[0] for t in temas if t != tema]
        opciones.extend(random.sample(otras_opciones, min(3, len(otras_opciones))))
        random.shuffle(opciones)
        return jsonify({
            "pregunta": pregunta,
            "opciones": opciones,
            "respuesta_correcta": base_pregunta,
            "tema": tema,
            "nivel": nivel,
            "retroalimentacion": temas.get(tema, {}).get(nivel, temas[tema]["basico"])
        })
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
        respuesta = bleach.clean(data.get("respuesta", "")[:500])
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", "")[:500])
        tema = bleach.clean(data.get("tema", "")[:50])
        nivel = bleach.clean(data.get("nivel", "basico")[:20])
        es_correcta = respuesta == respuesta_correcta
        delta_dominio = 0.1 if es_correcta else -0.05
        actualizar_dominio(usuario, tema, delta_dominio)
        progreso = cargar_progreso(usuario)
        puntos = progreso["puntos"] + (10 if es_correcta else -5)
        temas_aprendidos = progreso["temas_aprendidos"]
        if es_correcta and tema not in temas_aprendidos.split(","):
            temas_aprendidos = temas_aprendidos + ("," + tema if temas_aprendidos else tema)
        guardar_progreso(usuario, max(0, puntos), temas_aprendidos, nivel, progreso["avatar_id"])
        retroalimentacion = temas.get(tema, {}).get(nivel, temas[tema]["basico"])
        return jsonify({
            "correcta": es_correcta,
            "mensaje": "¡Correcto!" if es_correcta else "Incorrecto, intenta de nuevo.",
            "puntos": puntos,
            "retroalimentacion": retroalimentacion
        })
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error al procesar la respuesta del quiz: {str(e)}"}), 500

@app.route("/clear_chat", methods=["POST"])
def clear_chat():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("DELETE FROM logs WHERE usuario = %s", (usuario,))
        conn.commit()
        conn.close()
        return jsonify({"mensaje": "Chat limpiado con éxito"})
    except PsycopgError as e:
        logging.error(f"Error al limpiar chat: {str(e)}")
        return jsonify({"error": f"Error al limpiar el chat: {str(e)}"}), 500

@app.route("/recomendar_tema", methods=["GET"])
def recomendar_tema_endpoint():
    try:
        usuario = bleach.clean(request.args.get("usuario", "anonimo")[:50])
        tema = recomendar_tema(usuario)
        return jsonify({"tema": tema})
    except Exception as e:
        logging.error(f"Error en /recomendar_tema: {str(e)}")
        return jsonify({"error": f"Error al recomendar tema: {str(e)}"}), 500

if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)))