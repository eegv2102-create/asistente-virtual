# app.py - Refactorizado con correcciones para error en /buscar_respuesta y robustez mejorada
import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file, session, Blueprint
from flask_session import Session
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError, sql
import httpx
import bleach
from gtts import gTTS
import io
import retrying
import re
import uuid
from cachetools import TTLCache
from pydantic import BaseModel, ValidationError
from typing import Annotated, List, Optional
from pydantic.types import StringConstraints

# Configurar logging con structlog
import structlog

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.processors.JSONRenderer()
    ],
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)
logger = structlog.get_logger()
logging.basicConfig(level=logging.INFO)

# Cargar variables de entorno
load_dotenv()

# Inicializar Flask
app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'tu_clave_secreta')
app.config['SESSION_TYPE'] = 'filesystem'
app.config['SESSION_PERMANENT'] = True  # Persistir sesión tras reinicios
Session(app)

# Configurar rate limiting
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://"
)

# Configurar caché en memoria
cache = TTLCache(maxsize=100, ttl=72 * 60 * 60)  # 72 horas para TTS y temas

# Configurar timeouts desde .env
GROQ_RETRY_ATTEMPTS = int(os.getenv('GROQ_RETRY_ATTEMPTS', 3))
GROQ_RETRY_WAIT = int(os.getenv('GROQ_RETRY_WAIT', 5000))
GTTS_TIMEOUT = int(os.getenv('GTTS_TIMEOUT', 10))

# Inicializar Groq client
client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# --- Modelos de Validación con Pydantic ---
class BuscarRespuestaInput(BaseModel):
    pregunta: Annotated[str, StringConstraints(max_length=500)]
    historial: List = []
    nivel_explicacion: Annotated[str, StringConstraints(max_length=20)] = 'basica'
    conv_id: Optional[int] = None
    usuario: Optional[Annotated[str, StringConstraints(max_length=50)]] = None

class QuizInput(BaseModel):
    usuario: Annotated[str, StringConstraints(max_length=50)] = 'anonimo'
    historial: List = []
    nivel: Annotated[str, StringConstraints(max_length=20)] = 'basica'
    tema: Optional[Annotated[str, StringConstraints(max_length=100)]] = None

class ResponderQuizInput(BaseModel):
    pregunta: Annotated[str, StringConstraints(max_length=200)]
    respuesta: Annotated[str, StringConstraints(max_length=100)]
    respuesta_correcta: Annotated[str, StringConstraints(max_length=100)]
    tema: Annotated[str, StringConstraints(max_length=50)] = 'General'
    usuario: Optional[Annotated[str, StringConstraints(max_length=50)]] = None

class TTSInput(BaseModel):
    text: Annotated[str, StringConstraints(max_length=1000)]
    usuario: Optional[Annotated[str, StringConstraints(max_length=50)]] = None

class RecommendInput(BaseModel):
    usuario: Annotated[str, StringConstraints(max_length=50)] = 'anonimo'
    historial: List = []

class ConversationInput(BaseModel):
    nombre: Annotated[str, StringConstraints(max_length=100)] = 'Nuevo Chat'
    usuario: Optional[Annotated[str, StringConstraints(max_length=50)]] = None

class MessageInput(BaseModel):
    role: str
    content: str
    tema: Optional[str] = None
    usuario: Optional[Annotated[str, StringConstraints(max_length=50)]] = None

# --- Funciones de Lógica de Base de Datos ---
@retrying.retry(wait_fixed=GROQ_RETRY_WAIT, stop_max_attempt_number=GROQ_RETRY_ATTEMPTS)
def get_db_connection():
    """Establece una conexión a la base de datos PostgreSQL."""
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        conn.set_session(autocommit=False)
        logger.info("Conexión a la base de datos establecida")
        return conn
    except Exception as e:
        logger.error("Error al conectar con la base de datos", error=str(e))
        raise

def _col_exists(cursor, table, column):
    """Verifica si una columna existe en una tabla."""
    cursor.execute("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = %s AND column_name = %s
    """, (table, column))
    return cursor.fetchone() is not None

def _ensure_created_at(cursor, table):
    """Asegura que la columna 'created_at' exista en la tabla, migrando si es necesario."""
    has_created = _col_exists(cursor, table, 'created_at')
    has_timestamp = _col_exists(cursor, table, 'timestamp')
    if has_timestamp and not has_created:
        cursor.execute(
            sql.SQL('ALTER TABLE {} RENAME COLUMN "timestamp" TO created_at')
               .format(sql.Identifier(table))
        )
        logger.info(f"[migración] Renombrado timestamp -> created_at en {table}")
    elif not has_timestamp and not has_created:
        cursor.execute(
            sql.SQL("ALTER TABLE {} ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
               .format(sql.Identifier(table))
        )
        logger.info(f"[migración] Añadido created_at en {table}")

def init_db():
    """Inicializa la base de datos creando tablas, migrando y añadiendo índices."""
    conn = None
    try:
        conn = get_db_connection()
        c = conn.cursor()

        # Crear tablas
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY,
                      puntos INTEGER DEFAULT 0,
                      temas_aprendidos TEXT DEFAULT '',
                      avatar_id TEXT DEFAULT 'default',
                      temas_recomendados TEXT DEFAULT '')''')

        if not _col_exists(c, 'progreso', 'temas_recomendados'):
            c.execute("ALTER TABLE progreso ADD COLUMN temas_recomendados TEXT DEFAULT ''")
            logger.info("[migración] Añadido temas_recomendados en progreso")

        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT,
                      pregunta TEXT,
                      respuesta TEXT,
                      nivel_explicacion TEXT,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY,
                      nombre TEXT,
                      url TEXT,
                      animation_url TEXT)''')

        c.execute("""INSERT INTO avatars (avatar_id, nombre, url, animation_url)
                     VALUES (%s, %s, %s, %s)
                     ON CONFLICT (avatar_id) DO NOTHING""",
                  ("default", "Avatar Predeterminado", "/static/favicon.ico", ""))

        c.execute('''CREATE TABLE IF NOT EXISTS quiz_logs
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT NOT NULL,
                      pregunta TEXT NOT NULL,
                      respuesta TEXT NOT NULL,
                      es_correcta BOOLEAN NOT NULL,
                      puntos INTEGER NOT NULL,
                      tema TEXT NOT NULL,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS conversations
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT NOT NULL,
                      nombre TEXT DEFAULT 'Nuevo Chat',
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS messages
                     (id SERIAL PRIMARY KEY,
                      conv_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                      role TEXT NOT NULL,
                      content TEXT NOT NULL,
                      tema TEXT,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        # Migrar tablas antiguas
        for table in ["logs", "quiz_logs", "conversations", "messages"]:
            _ensure_created_at(c, table)

        # Añadir campo tema si no existe
        if not _col_exists(c, 'messages', 'tema'):
            c.execute("ALTER TABLE messages ADD COLUMN tema TEXT")
            logger.info("[migración] Añadido campo tema en messages")

        # Índices existentes
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_quiz_logs ON quiz_logs(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_conversations ON conversations(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_conv_messages ON messages(conv_id, created_at)')

        # Índice adicional para búsquedas en messages.content
        c.execute('CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content text_pattern_ops)')

        conn.commit()
        logger.info("Base de datos inicializada correctamente (tablas + migraciones + índices)")
        return True
    except PsycopgError as e:
        logger.error("Error al inicializar la base de datos", error=str(e))
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()

def cargar_progreso(usuario):
    """Carga el progreso de un usuario desde la base de datos."""
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
        logger.error("Error al cargar progreso", error=str(e))
        return {"puntos": 0, "temas_aprendidos": "", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, avatar_id="default"):
    """Guarda o actualiza el progreso de un usuario en la base de datos."""
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, avatar_id) VALUES (%s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, avatar_id, puntos, temas_aprendidos, avatar_id))
        conn.commit()
        conn.close()
        logger.info(f"Progreso guardado", usuario=usuario, puntos=puntos, temas=temas_aprendidos)
    except PsycopgError as e:
        logger.error("Error al guardar progreso", error=str(e))

def guardar_mensaje(usuario, conv_id, role, content, tema=None):
    """Guarda un mensaje en la base de datos."""
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO messages (conv_id, role, content, tema) VALUES (%s, %s, %s, %s)", 
                  (conv_id, role, content, tema))
        conn.commit()
        conn.close()
        logger.info(f"Mensaje guardado", usuario=usuario, conv_id=conv_id, role=role, tema=tema)
    except PsycopgError as e:
        logger.error("Error al guardar mensaje", error=str(e))

def validar_conversacion(usuario, conv_id):
    """Valida si una conversación pertenece al usuario y existe."""
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT id FROM conversations WHERE id = %s AND usuario = %s", (conv_id, usuario))
        result = c.fetchone()
        conn.close()
        return result is not None
    except PsycopgError as e:
        logger.error("Error al validar conversación", error=str(e))
        return False

def crear_nueva_conversacion(usuario, nombre="Nuevo Chat"):
    """Crea una nueva conversación y devuelve su ID."""
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO conversations (usuario, nombre) VALUES (%s, %s) RETURNING id", (usuario, nombre))
        conv_id = c.fetchone()[0]
        saludo_inicial = "Hola, soy YELIA 👋. ¿En qué tema de Programación Avanzada quieres que te ayude hoy?"
        c.execute("INSERT INTO messages (conv_id, role, content, tema) VALUES (%s, %s, %s, %s)",
                  (conv_id, 'bot', saludo_inicial, TEMAS_DISPONIBLES[0] if TEMAS_DISPONIBLES else 'General'))
        conn.commit()
        conn.close()
        logger.info("Nueva conversación creada", conv_id=conv_id, usuario=usuario, nombre=nombre)
        return conv_id
    except PsycopgError as e:
        logger.error("Error al crear nueva conversación", error=str(e))
        raise

# --- Funciones Auxiliares ---
@retrying.retry(wait_fixed=GROQ_RETRY_WAIT, stop_max_attempt_number=GROQ_RETRY_ATTEMPTS)
def call_groq_api(messages, model, max_tokens, temperature):
    """Llama a la API de Groq con reintentos."""
    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature
        )
        if not response.choices or not response.choices[0].message.content:
            raise ValueError("Respuesta de Groq vacía o inválida")
        return response
    except Exception as e:
        logger.error("Error en Groq API", error=str(e))
        if '503' in str(e):
            raise Exception("Groq API unavailable (503). Check https://groqstatus.com/")
        raise

def cargar_temas():
    """Carga temas desde archivo JSON o usa defaults, con caché."""
    global temas
    cache_key = 'temas'
    temas_disponibles = []

    if cache_key in cache:
        temas = cache[cache_key]
        logger.info("Temas cargados desde caché")
        for unidad in temas.get("Unidades", []):
            for tema in unidad.get("temas", []):
                if 'nombre' in tema:
                    temas_disponibles.append(tema['nombre'])
        return temas_disponibles

    try:
        with open('temas.json', 'r', encoding='utf-8') as f:
            temas = json.load(f)
        cache[cache_key] = temas
        for unidad in temas.get("Unidades", []):
            for tema in unidad.get("temas", []):
                if 'nombre' in tema:
                    temas_disponibles.append(tema['nombre'])
        logger.info(f"Temas cargados desde archivo: {temas_disponibles}")
        return temas_disponibles
    except FileNotFoundError:
        logger.error("Archivo temas.json no encontrado")
        temas = {}
        return [
            'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
            'Polimorfismo', 'Clases Abstractas e Interfaces', 'Lenguaje de Modelado Unificado (UML)',
            'Diagramas UML', 'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
            'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
        ]
    except json.JSONDecodeError as e:
        logger.error("Error al decodificar temas.json", error=str(e))
        temas = {}
        return []

# --- Manejo Global de Errores ---
@app.errorhandler(Exception)
def handle_exception(e):
    """Maneja errores globales en la aplicación."""
    logger.error("Error inesperado", error=str(e), exc_info=True)
    if isinstance(e, httpx.ConnectTimeout):
        return jsonify({"error": "Tiempo de conexión agotado, verifica tu conexión a internet", "status": 504}), 504
    if isinstance(e, ValidationError):
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    return jsonify({"error": f"Error interno del servidor: {str(e)}", "status": 500}), 500

# Validar variables de entorno
if not os.getenv("GROQ_API_KEY"):
    logger.error("GROQ_API_KEY no configurada")
    exit(1)
if not os.getenv("DATABASE_URL"):
    logger.error("DATABASE_URL no configurada")
    exit(1)

# --- Blueprints para Modularizar Rutas ---
# Blueprint para rutas relacionadas con conversaciones y mensajes
chat_bp = Blueprint('chat', __name__)

@chat_bp.route('/messages/<int:conv_id>', methods=['GET', 'POST'])
@limiter.limit("50 per hour")
def handle_messages(conv_id):
    """Maneja obtención y guardado de mensajes en una conversación."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    if not validar_conversacion(usuario, conv_id):
        logger.warning("Conversación no válida, creando una nueva", conv_id=conv_id, usuario=usuario)
        conv_id = crear_nueva_conversacion(usuario)
        session['current_conv_id'] = conv_id

    if request.method == 'GET':
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("""
                SELECT id, role, content, created_at, tema
                FROM messages
                WHERE conv_id = %s
                ORDER BY created_at ASC
            """, (conv_id,))
            rows = c.fetchall()
            conn.close()

            messages = [
                {
                    "id": r[0],
                    "role": r[1],
                    "content": r[2],
                    "created_at": (r[3].isoformat() if r[3] else None),
                    "tema": r[4]
                } for r in rows
            ]
            logger.info("Mensajes obtenidos", conv_id=conv_id, usuario=usuario, message_count=len(messages))
            return jsonify({"messages": messages})
        except Exception as e:
            logger.error("Error obteniendo mensajes", error=str(e), conv_id=conv_id, usuario=usuario)
            return jsonify({"error": "No se pudieron obtener los mensajes", "status": 500}), 500

    try:
        data = MessageInput(**request.get_json())
        role = data.role
        content = data.content
        tema = data.tema

        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO messages (conv_id, role, content, tema)
            VALUES (%s, %s, %s, %s)
            RETURNING id, created_at
        """, (conv_id, role, content, tema))
        row = c.fetchone()
        conn.commit()
        conn.close()

        logger.info("Mensaje guardado en messages", conv_id=conv_id, role=role, usuario=usuario)
        return jsonify({
            "id": row[0],
            "role": role,
            "content": content,
            "created_at": row[1].isoformat() if row[1] else None
        })
    except ValidationError as e:
        logger.error("Validación fallida en /messages", error=str(e), conv_id=conv_id, usuario=usuario)
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error guardando mensaje", error=str(e), conv_id=conv_id, usuario=usuario)
        return jsonify({"error": "No se pudo guardar el mensaje", "status": 500}), 500

@chat_bp.route('/conversations', methods=['GET'])
@limiter.limit("50 per hour")
def list_conversations():
    """Lista todas las conversaciones de un usuario."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            SELECT id, nombre, created_at
            FROM conversations
            WHERE usuario = %s
            ORDER BY created_at DESC, id DESC
        """, (usuario,))
        rows = c.fetchall()
        conn.close()

        conversations = [
            {
                "id": r[0],
                "nombre": r[1] or "Nuevo Chat",
                "created_at": (r[2].isoformat() if r[2] else None)
            } for r in rows
        ]
        logger.info("Conversaciones listadas", usuario=usuario, conversation_count=len(conversations))
        return jsonify({"conversations": conversations})
    except Exception as e:
        logger.error("Error listando conversaciones", error=str(e), usuario=usuario)
        return jsonify({"error": "No se pudieron obtener las conversaciones", "status": 500}), 500

@chat_bp.route('/conversations/<int:conv_id>', methods=['DELETE', 'PUT'])
@limiter.limit("50 per hour")
def manage_conversation(conv_id):
    """Maneja eliminación y renombrado de conversaciones."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    if request.method == 'DELETE':
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("DELETE FROM conversations WHERE id = %s AND usuario = %s", (conv_id, usuario))
            if c.rowcount == 0:
                conn.close()
                logger.warning("Conversación no encontrada o no autorizada", conv_id=conv_id, usuario=usuario)
                return jsonify({'error': 'Conversación no encontrada o no autorizada', "status": 404}), 404
            conn.commit()
            conn.close()
            if session.get('current_conv_id') == conv_id:
                session.pop('current_conv_id', None)
            logger.info("Conversación eliminada", conv_id=conv_id, usuario=usuario)
            return jsonify({'success': True})
        except Exception as e:
            logger.error("Error eliminando conversación", error=str(e), conv_id=conv_id, usuario=usuario)
            return jsonify({'error': f"No se pudo eliminar la conversación: {str(e)}", "status": 500}), 500
    elif request.method == 'PUT':
        try:
            data = ConversationInput(**request.get_json())
            nuevo_nombre = data.nombre
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("UPDATE conversations SET nombre = %s WHERE id = %s AND usuario = %s", (nuevo_nombre, conv_id, usuario))
            if c.rowcount == 0:
                conn.close()
                logger.warning("Conversación no encontrada o no autorizada", conv_id=conv_id, usuario=usuario)
                return jsonify({'error': 'Conversación no encontrada o no autorizada', "status": 404}), 404
            conn.commit()
            conn.close()
            logger.info("Conversación renombrada", conv_id=conv_id, usuario=usuario, nuevo_nombre=nuevo_nombre)
            return jsonify({'success': True, 'nombre': nuevo_nombre})
        except ValidationError as e:
            logger.error("Validación fallida en /conversations PUT", error=str(e), conv_id=conv_id, usuario=usuario)
            return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
        except Exception as e:
            logger.error("Error renombrando conversación", error=str(e), conv_id=conv_id, usuario=usuario)
            return jsonify({'error': f"No se pudo renombrar la conversación: {str(e)}", "status": 500}), 500

@chat_bp.route('/conversations', methods=['POST'])
@limiter.limit("50 per hour")
def create_conversation():
    """Crea una nueva conversación con un mensaje de saludo inicial."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        data = ConversationInput(**request.get_json(silent=True) or {})
        nombre = data.nombre
        conv_id = crear_nueva_conversacion(usuario, nombre)
        session['current_conv_id'] = conv_id
        logger.info("Conversación creada manualmente", conv_id=conv_id, usuario=usuario, nombre=nombre)
        return jsonify({
            "id": conv_id,
            "nombre": nombre,
            "created_at": time.time(),
            "mensaje": "Hola, soy YELIA 👋. ¿En qué tema de Programación Avanzada quieres que te ayude hoy?"
        }), 201
    except ValidationError as e:
        logger.error("Validación fallida en /conversations POST", error=str(e), usuario=usuario)
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error creando conversación", error=str(e), usuario=usuario)
        return jsonify({"error": "No se pudo crear la conversación", "status": 500}), 500

@chat_bp.route('/logout', methods=['POST'])
@limiter.limit("10 per hour")
def logout():
    """Limpia la sesión del usuario para forzar un nuevo chat al volver a entrar."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    if 'usuario' in session:
        usuario = session['usuario']
        session.clear()
        logger.info("Sesión cerrada", usuario=usuario)
        return jsonify({"success": True, "message": "Sesión cerrada, se creará un nuevo chat al volver a entrar."})
    return jsonify({"success": True, "message": "No había sesión activa."})

@chat_bp.route('/buscar_respuesta', methods=['POST'])
@limiter.limit("50 per hour")
def buscar_respuesta():
    """Busca respuesta usando Groq API basada en la pregunta del usuario."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        # Validar JSON recibido
        data = BuscarRespuestaInput(**request.get_json())
        pregunta = data.pregunta.strip()
        historial = data.historial
        nivel_explicacion = data.nivel_explicacion
        conv_id = data.conv_id

        # Validar o crear conversación
        if not conv_id or not validar_conversacion(usuario, conv_id):
            conv_id = crear_nueva_conversacion(usuario)
            session['current_conv_id'] = conv_id
        elif conv_id != session.get('current_conv_id'):
            session['current_conv_id'] = conv_id

        # Normalizar pregunta para identificar tema
        pregunta_norm = pregunta.lower().strip()

        # Construir contexto a partir del historial
        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join(
                [f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]]
            )

        # Identificar tema basado en TEMAS_DISPONIBLES
        tema_identificado = None
        for tema in TEMAS_DISPONIBLES:
            if tema.lower() in pregunta_norm:
                tema_identificado = tema
                break
        if not tema_identificado:
            tema_identificado = TEMAS_DISPONIBLES[0] if TEMAS_DISPONIBLES else 'General'

        # Verificar si el último mensaje es el saludo inicial
        saludo_inicial = "Hola, soy YELIA 👋. ¿En qué tema de Programación Avanzada quieres que te ayude hoy?"
        es_saludo_duplicado = False
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT content FROM messages WHERE conv_id = %s ORDER BY created_at DESC LIMIT 1", (conv_id,))
                ultimo_mensaje = cur.fetchone()
                if ultimo_mensaje and ultimo_mensaje[0] == saludo_inicial:
                    es_saludo_duplicado = True

        # Respuestas simples para preguntas comunes
        respuestas_simples = {
            r"^(hola|¡hola!|buenos días|buenas tardes|buenas noches|hey|hi)$": (
                "Hola, ¿cómo puedo ayudarte con Programación Avanzada hoy?"
                if not es_saludo_duplicado else None
            ),
            r"^(qu[ié] eres|qu[ié] es yelia|quien eres|quien es yelia)$": (
                "Soy YELIA, un tutor de Programación Avanzada para Ingeniería en Telemática. "
                "Puedo explicarte temas como POO, UML, patrones de diseño, y más. ¿Qué quieres aprender?"
            ),
            r"^(ayuda|help|qué puedes hacer|que puedes hacer)$": (
                "Puedo explicarte temas de Programación Avanzada, generar quizzes, recomendar temas y convertir texto a voz. "
                f"Prueba con una pregunta sobre {tema_identificado} o pide un quiz."
            )
        }

        # Verificar si la pregunta coincide con una respuesta simple
        for patron, respuesta in respuestas_simples.items():
            if re.match(patron, pregunta_norm, re.IGNORECASE) and respuesta:
                guardar_mensaje(usuario, conv_id, 'user', pregunta, tema=tema_identificado)
                guardar_mensaje(usuario, conv_id, 'bot', respuesta, tema=tema_identificado)
                logger.info("Respuesta simple enviada", pregunta=pregunta, usuario=usuario, conv_id=conv_id)
                return jsonify({'respuesta': respuesta, 'conv_id': conv_id})

        # Construir prompt completo para Groq API
        prompt = (
            f"Eres YELIA, un tutor especializado en Programación Avanzada para Ingeniería en Telemática. "
            f"Sigue estas instrucciones estrictamente:\n"
            f"1. Responde solo sobre los temas: {', '.join(TEMAS_DISPONIBLES)}.\n"
            f"2. Nivel de explicación: '{nivel_explicacion}'.\n"
            f"   - 'basica': SOLO una definición clara y concisa (máximo 70 palabras) en texto plano, sin Markdown, negritas, listas, ejemplos, ventajas, comparaciones o bloques de código.\n"
            f"   - 'ejemplos': Definición breve (máximo 80 palabras) + UN SOLO ejemplo en Java (máximo 10 líneas, con formato Markdown). Prohibido incluir ventajas o comparaciones. Usa título '## Ejemplo en Java'.\n"
            f"   - 'avanzada': Definición (máximo 80 palabras) + lista de 2-3 ventajas (máximo 50 palabras) + UN SOLO ejemplo en Java (máximo 10 líneas, con formato Markdown). Puede incluir UNA comparación breve con otro concepto (máximo 20 palabras). Usa títulos '## Ventajas', '## Ejemplo en Java', y '## Comparación' si aplica.\n"
            f"3. Si la pregunta es ambigua (e.g., solo 'Herencia'), asume que se refiere al tema correspondiente de la lista.\n"
            f"4. Usa Markdown para estructurar la respuesta SOLO en 'ejemplos' y 'avanzada' (títulos con ##, lista con -).\n"
            f"5. Mantén el hilo de la conversación basado en el contexto previo, respondiendo naturalmente como un chat continuo (ej. si piden ejemplo en vida real, extiende el ejemplo anterior).\n"
            f"6. Si la pregunta menciona 'curiosidad' o 'dato curioso', proporciona un hecho interesante breve (máximo 50 palabras) relacionado con el tema, motivando al aprendizaje.\n"
            f"7. No hagas preguntas al usuario ni digas 'por favor' ni 'espero haberte ayudado'.\n"
            f"8. No uses emoticones ni emojis.\n"
            f"9. Si no se puede responder, sugiere un tema de la lista.\n"
            f"Contexto: {contexto}\n"
            f"Timestamp: {int(time.time())}"
        )

        try:
            completion = call_groq_api(
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": pregunta}
                ],
                model="llama3-70b-8192",
                max_tokens=300,
                temperature=0.2
            )
            # Validar la respuesta de Groq
            if not completion.choices or not hasattr(completion.choices[0], 'message') or not completion.choices[0].message.content:
                raise ValueError("Respuesta de Groq vacía o inválida")
            respuesta = completion.choices[0].message.content.strip()
            if not respuesta:
                respuesta = f"Lo siento, no pude generar una respuesta. Intenta con una pregunta sobre {tema_identificado}."
            guardar_mensaje(usuario, conv_id, 'user', pregunta, tema=tema_identificado)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta, tema=tema_identificado)
            logger.info("Respuesta generada", pregunta=pregunta, usuario=usuario, conv_id=conv_id, tema=tema_identificado)
            return jsonify({'respuesta': respuesta, 'conv_id': conv_id})
        except Exception as e:
            logger.error("Error al procesar respuesta de Groq", error=str(e), pregunta=pregunta, usuario=usuario, conv_id=conv_id)
            respuesta = (
                f"Lo siento, no pude procesar tu pregunta. "
                f"Intenta con una pregunta sobre Programación Avanzada, como {tema_identificado}."
            )
            guardar_mensaje(usuario, conv_id, 'user', pregunta, tema=tema_identificado)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta, tema=tema_identificado)
            return jsonify({'respuesta': respuesta, 'conv_id': conv_id})
    except ValidationError as e:
        logger.error("Validación fallida en /buscar_respuesta", error=str(e), usuario=usuario)
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error en /buscar_respuesta", error=str(e), usuario=usuario)
        return jsonify({"error": f"Error al procesar la solicitud: {str(e)}", "status": 500}), 500

# Blueprint para rutas relacionadas con quiz
quiz_bp = Blueprint('quiz', __name__)

@quiz_bp.route('/quiz', methods=['POST'])
@limiter.limit("20 per hour")
def quiz():
    """Genera una pregunta de quiz usando Groq API."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        data = QuizInput(**request.get_json())
        historial = data.historial
        nivel = data.nivel.lower()
        tema_seleccionado = data.tema if data.tema in TEMAS_DISPONIBLES else random.choice(TEMAS_DISPONIBLES)

        # Crear o validar conversación
        conv_id = session.get('current_conv_id')
        if not conv_id or not validar_conversacion(usuario, conv_id):
            conv_id = crear_nueva_conversacion(usuario)
            session['current_conv_id'] = conv_id

        def validate_quiz_format(quiz_data):
            required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]
            if not all(key in quiz_data for key in required_keys):
                raise ValueError("Faltan claves requeridas en quiz_data")
            if not isinstance(quiz_data["opciones"], list) or len(quiz_data["opciones"]) != 4:
                raise ValueError("Opciones deben ser una lista de exactamente 4 elementos")
            if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
                raise ValueError("Respuesta correcta no está en las opciones")
            if quiz_data["tema"] not in TEMAS_DISPONIBLES:
                raise ValueError(f"Tema {quiz_data['tema']} no es válido")
            if quiz_data["nivel"].lower() not in ["basica", "basico", "intermedio", "avanzada"]:
                raise ValueError(f"Nivel {quiz_data['nivel']} no es válido")

        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        prompt = (
            f"Eres YELIA, un tutor especializado en Programación Avanzada para Ingeniería en Telemática. Civilian"
            f"Genera una pregunta de opción múltiple (4 opciones, 1 correcta) sobre el tema '{tema_seleccionado}' "
            f"para el nivel '{nivel}'. Devuelve un objeto JSON con las claves: "
            f"'pregunta' (máximo 100 caracteres), 'opciones' (lista de 4 strings, máximo 50 caracteres cada una), "
            f"'respuesta_correcta' (string, debe coincidir con una opción), 'tema' (string), 'nivel' (string). "
            f"No uses Markdown, emojis, ni texto adicional. Usa 'nivel': '{nivel}' exactamente. "
            f"Contexto: {contexto}\nTemas disponibles: {', '.join(TEMAS_DISPONIBLES)}"
        )

        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera una pregunta de quiz."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.2
        )

        try:
            quiz_data = json.loads(completion.choices[0].message.content.strip())
            validate_quiz_format(quiz_data)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error("Error en el formato del quiz de Groq", error=str(e), usuario=usuario, tema=tema_seleccionado)
            quiz_data = {
                "pregunta": f"¿Qué permite ocultar los detalles internos de una clase?" if tema_seleccionado == "Encapsulamiento" else f"¿Qué diagrama UML muestra la estructura estática?",
                "opciones": ["Encapsulamiento", "Herencia", "Polimorfismo", "Abstracción"] if tema_seleccionado == "Encapsulamiento" else ["Diagrama de Clases", "Diagrama de Actividades", "Diagrama de Estados", "Diagrama de Componentes"],
                "respuesta_correcta": "Encapsulamiento" if tema_seleccionado == "Encapsulamiento" else "Diagrama de Clases",
                "tema": tema_seleccionado,
                "nivel": nivel
            }
            try:
                validate_quiz_format(quiz_data)
            except ValueError as ve:
                logger.error("Formato de quiz de respaldo inválido", error=str(ve), usuario=usuario)
                return jsonify({"error": "No se pudo generar un quiz válido", "status": 500}), 500

        # Guardar la pregunta del quiz como mensaje
        pregunta_texto = f"{quiz_data['pregunta']} Opciones: {', '.join(quiz_data['opciones'])}"
        guardar_mensaje(usuario, conv_id, 'bot', pregunta_texto, tema=quiz_data['tema'])
        logger.info("Quiz generado", usuario=usuario, tema=quiz_data['tema'], nivel=nivel, conv_id=conv_id)
        return jsonify(quiz_data | {"conv_id": conv_id})
    except ValidationError as e:
        logger.error("Validación fallida en /quiz", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error en /quiz", error=str(e), usuario=session.get('usuario', 'anonimo'))
        if '503' in str(e):
            return jsonify({"error": "Groq API unavailable (503). Check https://groqstatus.com/", "status": 503}), 503
        return jsonify({"error": f"Error al generar quiz: {str(e)}", "status": 500}), 500

@quiz_bp.route('/responder_quiz', methods=['POST'])
@limiter.limit("20 per hour")
def responder_quiz():
    """Procesa la respuesta del usuario a un quiz."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        data = ResponderQuizInput(**request.get_json())
        respuesta = data.respuesta
        respuesta_correcta = data.respuesta_correcta
        tema = data.tema
        pregunta = data.pregunta

        # Validar o crear conversación
        conv_id = session.get('current_conv_id')
        if not conv_id or not validar_conversacion(usuario, conv_id):
            conv_id = crear_nueva_conversacion(usuario)
            session['current_conv_id'] = conv_id

        respuesta_norm = ''.join(respuesta.strip().lower().split())
        respuesta_correcta_norm = ''.join(respuesta_correcta.strip().lower().split())
        es_correcta = respuesta_norm == respuesta_correcta_norm
        logger.info("Comparando respuesta", respuesta=respuesta_norm, respuesta_correcta=respuesta_correcta_norm, es_correcta=es_correcta, usuario=usuario)

        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            puntos = 10 if es_correcta else 0
            cursor.execute(
                'INSERT INTO quiz_logs (usuario, pregunta, respuesta, es_correcta, tema, puntos) VALUES (%s, %s, %s, %s, %s, %s)',
                (usuario, pregunta, respuesta, es_correcta, tema, puntos)
            )
            conn.commit()
            cursor.close()
            conn.close()
            logger.info("Quiz guardado en quiz_logs", usuario=usuario, pregunta=pregunta, respuesta=respuesta)
        except PsycopgError as e:
            logger.error("Error al guardar en quiz_logs", error=str(e), usuario=usuario)
            return jsonify({"error": f"Error de base de datos al guardar quiz: {str(e)}", "status": 500}), 500

        try:
            prompt = (
                f"Eres YELIA, un tutor educativo de Programación Avanzada para Ingeniería en Telemática. "
                f"El usuario respondió a la pregunta: '{pregunta}'. "
                f"La respuesta dada fue: '{respuesta}'. "
                f"La respuesta correcta es: '{respuesta_correcta}'. "
                f"La respuesta es {'correcta' if es_correcta else 'incorrecta'}. "
                f"Proporciona una explicación breve en español de por qué la respuesta correcta es adecuada (máximo 50 palabras). "
                f"Si es incorrecta, explica por qué la seleccionada es errónea y por qué la correcta es adecuada. "
                f"Responde solo con la explicación, sin formato adicional ni Markdown."
            )
            response = call_groq_api(
                messages=[{"role": "system", "content": prompt}],
                model="llama3-70b-8192",
                max_tokens=100,
                temperature=0.2
            )
            explicacion = response.choices[0].message.content.strip()
        except Exception as e:
            logger.error("Error al generar explicación con Groq", error=str(e), usuario=usuario)
            explicacion = (
                f"La respuesta es {'correcta' if es_correcta else 'incorrecta'}. "
                f"{'La respuesta es correcta.' if es_correcta else 'La respuesta seleccionada no es adecuada.'} "
            )

        # Guardar la explicación como mensaje
        guardar_mensaje(usuario, conv_id, 'bot', explicacion, tema=tema)
        logger.info("Respuesta de quiz procesada", es_correcta=es_correcta, usuario=usuario, conv_id=conv_id)
        return jsonify({
            'es_correcta': es_correcta,
            'explicacion': explicacion,
            'respuesta_correcta': respuesta_correcta,
            'conv_id': conv_id
        })
    except ValidationError as e:
        logger.error("Validación fallida en /responder_quiz", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error en /responder_quiz", error=str(e), usuario=session.get('usuario', 'anonimo'))
        if '503' in str(e):
            return jsonify({"error": "Servidor de Groq no disponible, intenta de nuevo más tarde", "status": 503}), 503
        return jsonify({"error": f"No se pudo procesar la respuesta del quiz: {str(e)}", "status": 500}), 500

# Blueprint para rutas relacionadas con TTS
tts_bp = Blueprint('tts', __name__)

@tts_bp.route("/tts", methods=["POST"])
@limiter.limit("5 per hour")
def tts():
    """Genera audio TTS a partir de texto."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        data = TTSInput(**request.get_json())
        text = data.text
        if not text:
            logger.error("Texto vacío en /tts", usuario=usuario)
            return jsonify({"error": "El texto no puede estar vacío", "status": 400}), 400
        if not all(c.isprintable() or c.isspace() for c in text):
            logger.error("Texto contiene caracteres no válidos", usuario=usuario)
            return jsonify({"error": "El texto contiene caracteres no válidos", "status": 400}), 400

        # Caché de audio
        cache_key = f"tts:{text}"
        if cache_key in cache:
            logger.info("Audio servido desde caché", text=text, usuario=usuario)
            audio_bytes = cache[cache_key]
            audio_io = io.BytesIO(audio_bytes)
            return send_file(audio_io, mimetype='audio/mp3')

        reemplazos = {
            'POO': 'Programación Orientada a Objetos',
            'UML': 'U Em Ele',
            'MVC': 'Em Vi Ci',
            'ORM': 'Mapeo Objeto Relacional',
            'BD': 'Base de Datos'
        }
        for term, replacement in reemplazos.items():
            text = re.sub(rf'\b{term}\b', replacement, text, flags=re.IGNORECASE)

        try:
            tts = gTTS(text=text, lang='es', tld='com.mx', timeout=GTTS_TIMEOUT)
            audio_io = io.BytesIO()
            tts.write_to_fp(audio_io)
            audio_bytes = audio_io.getvalue()
            cache[cache_key] = audio_bytes
            audio_io.seek(0)
            logger.info("Audio generado exitosamente", text=text, usuario=usuario)
            return send_file(audio_io, mimetype='audio/mp3')
        except Exception as gtts_error:
            logger.error("Error en gTTS", error=str(gtts_error), usuario=usuario)
            if "429" in str(gtts_error):
                return jsonify({"error": "Límite de solicitudes alcanzado en gTTS, espera unos minutos", "status": 429}), 429
            if isinstance(gtts_error, httpx.ConnectTimeout):
                return jsonify({"error": "Tiempo de conexión agotado en gTTS, verifica tu conexión a internet", "status": 504}), 504
            return jsonify({"error": f"Error en la generación de audio: {str(gtts_error)}", "status": 500}), 500
    except ValidationError as e:
        logger.error("Validación fallida en /tts", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error en /tts", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({"error": f"Error al procesar la solicitud: {str(e)}", "status": 500}), 500

# Blueprint para rutas relacionadas con recomendaciones
recommend_bp = Blueprint('recommend', __name__)

@recommend_bp.route("/recommend", methods=["POST"])
@limiter.limit("20 per hour")
@retrying.retry(wait_fixed=GROQ_RETRY_WAIT, stop_max_attempt_number=GROQ_RETRY_ATTEMPTS)
def recommend():
    """Genera una recomendación de tema usando Groq API."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        data = RecommendInput(**request.get_json())
        historial = data.historial

        # Crear o validar conversación
        conv_id = session.get('current_conv_id')
        if not conv_id or not validar_conversacion(usuario, conv_id):
            conv_id = crear_nueva_conversacion(usuario)
            session['current_conv_id'] = conv_id

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad in temas.get("Unidades", []):
            for tema in unidad.get("temas", []):
                if 'nombre' in tema:
                    temas_disponibles.append(tema['nombre'])

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
            logger.error("Error al cargar temas recomendados", error=str(e), usuario=usuario)
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
            "Devuelve un objeto JSON válido con una clave 'recommendation' (ej. {\"recommendation\": \"Polimorfismo\"}). "
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
            recomendacion_data = json.loads(completion.choices[0].message.content.strip())
            recomendacion = recomendacion_data.get("recommendation", "")
            if not recomendacion:
                raise json.JSONDecodeError("Recommendation vacía", "", 0)
        except json.JSONDecodeError as je:
            logger.error("Error al decodificar JSON de Groq en /recommend", error=str(je), usuario=usuario)
            recomendacion = random.choice(temas_disponibles_para_recomendar) if temas_disponibles_para_recomendar else random.choice(temas_disponibles)
            logger.warning(f"Usando recomendación de fallback: {recomendacion}", usuario=usuario)

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
            logger.error("Error al guardar temas recomendados", error=str(e), usuario=usuario)

        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        guardar_mensaje(usuario, conv_id, 'bot', recomendacion_texto, tema=recomendacion)
        logger.info("Recomendación generada", recomendacion=recomendacion_texto, usuario=usuario, conv_id=conv_id)
        return jsonify({"recommendation": recomendacion_texto, 'conv_id': conv_id})
    except ValidationError as e:
        logger.error("Validación fallida en /recommend", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({"error": f"Datos inválidos: {str(e)}", "status": 400}), 400
    except Exception as e:
        logger.error("Error en /recommend", error=str(e), usuario=session.get('usuario', 'anonimo'))
        recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)
        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logger.warning(f"Usando recomendación de fallback: {recomendacion_texto}", usuario=session.get('usuario', 'anonimo'))
        return jsonify({"recommendation": recomendacion_texto, 'conv_id': session.get('current_conv_id')})

# Blueprint para rutas de recursos (temas, avatares)
resources_bp = Blueprint('resources', __name__)

@resources_bp.route("/temas", methods=["GET"])
@limiter.limit("100 per hour")
def get_temas():
    """Obtiene la lista de temas disponibles."""
    cache_key = 'temas_response'
    if cache_key in cache:
        logger.info("Temas servidos desde caché")
        return cache[cache_key]

    try:
        temas_disponibles = []
        for unidad in temas.get("Unidades", []):
            for tema in unidad.get("temas", []):
                if 'nombre' in tema:
                    temas_disponibles.append(tema['nombre'])
        response = jsonify({"temas": temas_disponibles})
        cache[cache_key] = response
        logger.info("Temas disponibles enviados", temas=temas_disponibles)
        return response
    except Exception as e:
        logger.error("Error en /temas", error=str(e))
        return jsonify({"error": "Error al obtener temas", "status": 500}), 500

@resources_bp.route('/avatars', methods=['GET'])
@limiter.limit("100 per hour")
def get_avatars():
    """Obtiene la lista de avatares disponibles."""
    cache_key = 'avatars_response'
    if cache_key in cache:
        logger.info("Avatares servidos desde caché")
        return cache[cache_key]

    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        avatars = [{'avatar_id': row[0], 'nombre': row[1], 'url': row[2], 'animation_url': row[3]} for row in c.fetchall()]
        conn.close()
        response = jsonify({'avatars': avatars})
        cache[cache_key] = response
        logger.info("Avatares enviados", avatars=[avatar['nombre'] for avatar in avatars])
        return response
    except Exception as e:
        logger.error("Error al obtener avatares", error=str(e))
        response = jsonify({'avatars': [{'avatar_id': 'default', 'nombre': 'Avatar Predeterminado', 'url': '/static/favicon.ico', 'animation_url': ''}]})
        cache[cache_key] = response
        return response, 200

# --- Rutas Principales ---
@app.route('/')
def index():
    """Ruta principal que renderiza la interfaz."""
    # --- Manejo de userId persistente ---
    data_json = request.get_json(silent=True) or {}
    usuario = data_json.get("usuario") or session.get("usuario") or uuid.uuid4().hex
    session['usuario'] = usuario

    try:
        # Verificar si hay un chat activo
        conv_id = session.get('current_conv_id')
        if conv_id and not validar_conversacion(usuario, conv_id):
            session.pop('current_conv_id', None)
        logger.info("Accediendo a la ruta raíz", usuario=usuario)
        return render_template('index.html')
    except Exception as e:
        logger.error("Error al renderizar index.html", error=str(e), usuario=session.get('usuario', 'anonimo'))
        return jsonify({'error': 'Error al cargar la página principal', "status": 500}), 500

# Registrar Blueprints
app.register_blueprint(chat_bp)
app.register_blueprint(quiz_bp)
app.register_blueprint(tts_bp)
app.register_blueprint(recommend_bp)
app.register_blueprint(resources_bp)

# --- Inicialización de la Aplicación ---
try:
    logger.info("Iniciando inicialización de DB")
    init_db()
    logger.info("DB inicializada con éxito")
except Exception as e:
    logger.error("Falló inicialización de DB", error=str(e))
    exit(1)

# Carga inicial de temas
temas = {}
TEMAS_DISPONIBLES = cargar_temas()

if __name__ == "__main__":
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 10000)))