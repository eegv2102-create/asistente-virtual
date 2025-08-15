# nlp.py - versión ligera para Render

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import json
import logging

# Configuración de logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar base de conocimientos
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas_dict = json.load(f)
    logging.info("Temas cargados correctamente en nlp.py")
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json en nlp.py: {e}")
    temas_dict = {
        "poo": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento.",
        "patrones de diseño": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software.",
        "multihilos": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento."
    }
    logging.warning("Usando temas por defecto en nlp.py")

corpus = list(temas_dict.values())
temas = list(temas_dict.keys())

vectorizer = TfidfVectorizer()
try:
    X = vectorizer.fit_transform(corpus)
    logging.info("Vectorizador TF-IDF inicializado correctamente")
except Exception as e:
    logging.error(f"Error al inicializar TF-IDF: {e}")
    X = None

def buscar_respuesta(pregunta, k=3):
    """
    Realiza una búsqueda semántica ligera usando TF-IDF y similitud coseno.
    Devuelve una lista de (tema, contenido, score) ordenados por relevancia.
    """
    try:
        if X is None:
            logging.warning("TF-IDF no inicializado")
            return []
        
        pregunta_vec = vectorizer.transform([pregunta.lower()])
        similitudes = cosine_similarity(pregunta_vec, X).flatten()
        
        # Obtener los top k índices ordenados por similitud descendente
        top_indices = similitudes.argsort()[-k:][::-1]
        results = []
        for idx in top_indices:
            score = float(similitudes[idx])
            if score > 0.0:  # Umbral mínimo para evitar resultados irrelevantes
                results.append((temas[idx], corpus[idx], score))
        
        return results
    except Exception as e:
        logging.error(f"Error al realizar búsqueda TF-IDF: {e}")
        return []

def classify_intent(text):
    """
    Clasificador de intenciones simple basado en palabras clave (reemplazo ligero).
    """
    try:
        text_lower = text.lower()
        if any(word in text_lower for word in ["hola", "saludo", "buenos dias"]):
            return "saludo"
        elif any(word in text_lower for word in ["definicion", "que es", "explica"]):
            return "definicion"
        elif any(word in text_lower for word in ["ejemplo", "dame un ejemplo"]):
            return "ejemplo"
        elif any(word in text_lower for word in ["quiz", "prueba", "examen"]):
            return "quiz"
        elif any(word in text_lower for word in ["cambiar nivel", "nivel"]):
            return "cambiar_nivel"
        return "definicion"  # Default
    except Exception as e:
        logging.error(f"Error al clasificar intención: {e}")
        return "definicion"

def normalize(text):
    """
    Normalización simple sin spaCy (reemplazo ligero).
    """
    try:
        return text.lower().strip()
    except Exception as e:
        logging.error(f"Error al normalizar texto: {e}")
        return text