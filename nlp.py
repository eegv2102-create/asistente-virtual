import re
import json
import logging
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Configuración de logging optimizada para Render
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar base de conocimientos
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas_dict = json.load(f)
    logging.info("Temas cargados correctamente en nlp.py")
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {e}")
    temas_dict = {
        "poo": {"basico": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento."},
        "patrones de diseño": {"basico": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software."},
        "multihilos": {"basico": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento."},
        "mvc": {"basico": "El patrón MVC separa la lógica de negocio, la interfaz de usuario y el control en tres componentes interconectados."}
    }
    logging.warning("Usando temas por defecto en nlp.py")

# Inicialización del vectorizador y corpus a nivel de módulo
vectorizer = TfidfVectorizer()
corpus = []
temas = []
X = None  # Inicialización inicial como None

def build_and_vectorize_corpus():
    """Reconstruye el corpus y vectoriza."""
    global corpus, temas, X
    corpus, temas = build_corpus()
    if not corpus:  # Verifica si el corpus está vacío
        logging.error("El corpus está vacío, no se puede vectorizar")
        return
    X = vectorizer.fit_transform(corpus)
    logging.info("Vectorizador TF-IDF inicializado/actualizado")

def build_corpus():
    """Construye el corpus dinámico."""
    corpus = []
    temas = []
    for tema, content in temas_dict.items():
        temas.append(tema)
        # Extrae el texto del nivel "basico" o usa una cadena vacía si no existe
        description = content.get("basico", "") if isinstance(content, dict) else content
        if isinstance(description, str) and description.strip():
            corpus.append(description)
        else:
            logging.warning(f"El tema {tema} no tiene una descripción válida, se omite")
    return corpus, temas

# Inicializar el corpus y vectorización al cargar el módulo
build_and_vectorize_corpus()

def buscar_respuesta(pregunta, k=3):
    """
    Realiza búsqueda semántica con TF-IDF y similitud coseno.
    Devuelve lista de (tema, contenido, score) ordenados por relevancia.
    """
    try:
        if X is None or not corpus:
            logging.warning("TF-IDF no inicializado o corpus vacío")
            return []
        pregunta_vec = vectorizer.transform([pregunta.lower()])
        similitudes = cosine_similarity(pregunta_vec, X).flatten()
        top_indices = similitudes.argsort()[-k:][::-1]
        results = []
        umbral = 0.3
        for idx in top_indices:
            score = float(similitudes[idx])
            if score > umbral:
                results.append((temas[idx], corpus[idx], score))
        return results
    except Exception as e:
        logging.error(f"Error en búsqueda TF-IDF: {e}")
        return []

def classify_intent(text):
    """
    Clasificador de intenciones basado en palabras clave y regex.
    """
    try:
        text_lower = text.lower()
        if any(word in text_lower for word in ["hola", "saludo", "buenos dias"]):
            return "saludo"
        elif re.search(r"ejemplo.*c[oó]digo|implementaci[oó]n|java", text_lower):
            return "ejemplo_codigo"
        elif any(word in text_lower for word in ["definicion", "que es", "explica"]):
            return "definicion"
        elif any(word in text_lower for word in ["quiz", "prueba", "examen"]):
            return "quiz"
        return "definicion"
    except Exception as e:
        logging.error(f"Error al clasificar intención: {e}")
        return "definicion"

def normalize(text):
    """
    Normalización simple del texto.
    """
    try:
        return text.lower().strip()
    except Exception as e:
        logging.error(f"Error al normalizar texto: {e}")
        return text