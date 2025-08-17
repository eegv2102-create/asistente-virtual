import re
import json
import logging
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Configuración de logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar base de conocimientos
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas_dict = json.load(f)
    logging.info("Temas cargados correctamente en nlp.py")
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {e}")
    temas_dict = {
        "poo": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento.",
        "patrones de diseño": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software.",
        "multihilos": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento.",
        "mvc": "El patrón MVC separa la lógica de negocio, la interfaz de usuario y el control en tres componentes interconectados."
    }
    logging.warning("Usando temas por defecto en nlp.py")

corpus = list(temas_dict.values())
temas = list(temas_dict.keys())

vectorizer = TfidfVectorizer()
try:
    X = vectorizer.fit_transform(corpus)
    logging.info("Vectorizador TF-IDF inicializado")
except Exception as e:
    logging.error(f"Error al inicializar TF-IDF: {e}")
    X = None

def buscar_respuesta(pregunta, k=3):
    """
    Realiza búsqueda semántica con TF-IDF y similitud coseno.
    Devuelve lista de (tema, contenido, score) ordenados por relevancia.
    """
    try:
        if X is None:
            logging.warning("TF-IDF no inicializado")
            return []
        pregunta_vec = vectorizer.transform([pregunta.lower()])
        similitudes = cosine_similarity(pregunta_vec, X).flatten()
        top_indices = similitudes.argsort()[-k:][::-1]
        results = []
        for idx in top_indices:
            score = float(similitudes[idx])
            if score > 0.4:  # Umbral reducido para capturar más coincidencias
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
        elif any(word in text_lower for word in ["cambiar nivel", "nivel"]):
            return "cambiar_nivel"
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