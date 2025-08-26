let vozActiva = localStorage.getItem('vozActiva') === 'true';
let isListening = false;
let recognition = null;
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;
let lastVoiceHintTime = 0;
let currentConvId = null;
let TEMAS_DISPONIBLES = [
    'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
    'Polimorfismo', 'Clases Abstractas e Interfaces', 'UML', 'Diagramas UML',
    'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
    'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
];

// Mejora 2: Función centralizada para manejar errores de fetch
const handleFetchError = (error, context) => {
    console.error(`Error en ${context}:`, error);
    let message = 'Error inesperado';
    if (!navigator.onLine) message = 'Sin conexión a internet';
    else if (error.message.includes('503')) message = 'El servidor está ocupado, intenta de nuevo';
    else if (error.message.includes('429')) message = 'Demasiadas solicitudes, espera un momento';
    else if (error.message.includes('401')) message = 'No autorizado, verifica tu sesión';
    else if (error.message) message = error.message;
    mostrarNotificacion(`${context}: ${message}`, 'error');
    return null;
};

// Mejora 3: Función debounce para eventos de clic
const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

// Mejora 4: Optimización de scrollToBottom
const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    const lastMessage = container.lastElementChild;
    if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
};

const getHistorial = () => {
    try {
        const historial = JSON.parse(localStorage.getItem('historial') || '[]');
        return Array.isArray(historial) ? historial : [];
    } catch (error) {
        console.error('Error al obtener historial:', error);
        return [];
    }
};

const showLoading = () => {
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return null;
    const loadingDiv = document.createElement('div');
    loadingDiv.classList.add('loading');
    loadingDiv.innerHTML = '<div class="spinner"></div> Cargando...';
    container.appendChild(loadingDiv);
    scrollToBottom();
    return loadingDiv;
};

const hideLoading = (loadingDiv) => {
    if (loadingDiv) loadingDiv.remove();
};

const getElement = selector => {
    const element = document.querySelector(selector);
    if (!element) console.warn(`Elemento ${selector} no encontrado en el DOM`);
    return element;
};

const getElements = selector => {
    const elements = document.querySelectorAll(selector);
    if (!elements.length) console.warn(`No se encontraron elementos para ${selector}`);
    return elements;
};

const mostrarNotificacion = (mensaje, tipo) => {
    const notificationCard = getElement('#notification-card');
    if (!notificationCard) return;
    notificationCard.innerHTML = `<p>${mensaje}</p><button onclick="this.parentElement.classList.remove('active')" aria-label="Cerrar notificación">Cerrar</button>`;
    notificationCard.classList.remove('info', 'success', 'error');
    notificationCard.classList.add(tipo, 'active');
    setTimeout(() => {
        notificationCard.classList.remove('active');
    }, 5000);
};

const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) {
        console.error('Elemento #voice-hint no encontrado');
        return;
    }
    const now = Date.now();
    if (show && now - lastVoiceHintTime < 5000) return;
    voiceHint.style.display = show ? 'block' : 'none';
    voiceHint.classList.toggle('hidden', !show);
    if (show) lastVoiceHintTime = now;
};

const speakText = async (text, audioUrl = null) => {
    console.log('Intentando reproducir audio:', { vozActiva, text, userHasInteracted, audioUrl });
    if (!vozActiva || !text) {
        console.warn('Audio desactivado o texto vacío', { vozActiva, text });
        mostrarNotificacion('Audio desactivado o texto vacío', 'error');
        return;
    }
    if (!userHasInteracted) {
        console.warn('No se puede reproducir audio: el usuario no ha interactuado');
        toggleVoiceHint(true);
        pendingWelcomeMessage = text;
        return;
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    if (currentAudio) {
        if (currentAudio instanceof Audio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        } else if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        currentAudio = null;
    }
    try {
        if (audioUrl) {
            // Usar audio de Ready Player Me si se proporciona
            currentAudio = new Audio(audioUrl);
            currentAudio.play().catch(error => {
                console.error('Error al reproducir audio de Ready Player Me:', error);
                mostrarNotificacion('Error al reproducir audio', 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            });
            currentAudio.onended = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
        } else {
            // Usar endpoint /tts existente
            const reemplazosTTS = {
                'POO': 'Programación Orientada a Objetos',
                'UML': 'U Em Ele',
                'MVC': 'Em Vi Ci',
                'ORM': 'Mapeo Objeto Relacional',
                'BD': 'Base de Datos',
                'API': 'A Pi I',
                'SQL': 'Esquiu Ele'
            };
            let textoParaVoz = text
                .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/`[^`]+`/g, '')
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/\*([^*]+)\*/g, '$1')
                .replace(/#+\s*/g, '')
                .replace(/-\s*/g, '')
                .replace(/\n+/g, ' ')
                .replace(/\b(POO|UML|MVC|ORM|BD)\b/g, match => reemplazosTTS[match] || match)
                .replace(/\bYELIA\b/g, 'Yelia')
                .trim();
            const res = await fetch('/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textoParaVoz })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || `Error en /tts: ${res.status} ${res.statusText}`);
            }
            const blob = await res.blob();
            currentAudio = new Audio(URL.createObjectURL(blob));
            currentAudio.play().catch(error => {
                console.error('Error al reproducir audio:', error);
                mostrarNotificacion('Error al reproducir audio: ' + error.message, 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            });
            currentAudio.onended = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
        }
    } catch (error) {
        console.error('Fallo en reproducción de audio, intentando speechSynthesis:', error);
        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            const esVoice = voices.find(v => v.lang.includes('es'));
            if (!esVoice) {
                console.warn('No se encontró voz en español');
                mostrarNotificacion('No se encontró voz en español', 'error');
                if (botMessage) botMessage.classList.remove('speaking');
                return;
            }
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'es-ES';
            utterance.voice = esVoice;
            utterance.pitch = 1;
            utterance.rate = 0.9;
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
            utterance.onerror = (event) => {
                console.error('Error en speechSynthesis:', event.error);
                let errorMsg = 'Error en audio local: ' + event.error;
                if (event.error === 'not-allowed') errorMsg = 'Audio no permitido, interactúa con la página primero';
                if (event.error === 'network') errorMsg = 'Error de red en síntesis de voz';
                mostrarNotificacion(errorMsg, 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            };
            speechSynthesis.speak(utterance);
            currentAudio = utterance;
        } else {
            console.warn('speechSynthesis no soportado');
            mostrarNotificacion('Audio no soportado en este navegador', 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

const stopSpeech = () => {
    console.log('Deteniendo audio');
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    }
    currentAudio = null;
    if (isListening && recognition) {
        recognition.stop();
        isListening = false;
        if (voiceToggleBtn) {
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        }
        mostrarNotificacion('Reconocimiento de voz detenido', 'info');
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

// Mejora 1: Optimización del reconocimiento de voz
const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) return;
    if (!isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado en este navegador', 'error');
            return;
        }
        recognition = ('webkitSpeechRecognition' in window) ? new webkitSpeechRecognition() : new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.continuous = true;
        let timeoutId = null;
        recognition.start();
        isListening = true;
        voiceToggleBtn.classList.add('voice-active');
        voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
        voiceToggleBtn.setAttribute('data-tooltip', 'Detener Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Detener reconocimiento de voz');
        voiceToggleBtn.classList.add('pulse');
        mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        const resetTimeout = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (isListening) stopSpeech();
                mostrarNotificacion('Reconocimiento de voz detenido por inactividad', 'info');
            }, 15000);
        };
        resetTimeout();
        recognition.onresult = event => {
            resetTimeout();
            const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            const input = getElement('#input');
            if (input) input.value = transcript;
            if (event.results[event.results.length - 1].isFinal) {
                sendMessage();
                recognition.stop();
                isListening = false;
                clearTimeout(timeoutId);
                voiceToggleBtn.classList.remove('voice-active', 'pulse');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        recognition.onerror = event => {
            clearTimeout(timeoutId);
            let errorMsg = `Error en reconocimiento de voz: ${event.error}`;
            if (event.error === 'no-speech') errorMsg = 'No se detectó voz, intenta de nuevo';
            if (event.error === 'aborted') errorMsg = 'Reconocimiento de voz cancelado';
            if (event.error === 'network') errorMsg = 'Error de red en reconocimiento de voz';
            mostrarNotificacion(errorMsg, 'error');
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active', 'pulse');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
                resetTimeout();
            } else {
                clearTimeout(timeoutId);
                voiceToggleBtn.classList.remove('voice-active', 'pulse');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
    } else {
        stopSpeech();
    }
};

const cargarConversaciones = async () => {
    try {
        const res = await fetch('/conversations');
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();
        const chatList = getElement('#chat-list');
        chatList.innerHTML = '';

        data.conversations.forEach(conv => {
            const li = document.createElement('li');
            li.dataset.id = conv.id;
            li.innerHTML = `
                <span class="chat-name">${conv.nombre}</span>
                <div class="chat-actions">
                    <button class="rename-btn" data-tooltip="Renombrar"><i class="fas fa-edit"></i></button>
                    <button class="delete-btn" data-tooltip="Eliminar"><i class="fas fa-trash"></i></button>
                </div>
            `;
            li.addEventListener('click', () => {
                currentConvId = conv.id;
                localStorage.setItem('lastConvId', currentConvId);
                cargarMensajes(conv.id);
            });
            chatList.appendChild(li);

            li.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                eliminarConversacion(conv.id);
            });
            li.querySelector('.rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                renombrarConversacion(conv.id);
            });
        });

        if (data.conversations.length > 0 && !currentConvId) {
            const lastConvId = localStorage.getItem('lastConvId');
            if (lastConvId) {
                currentConvId = parseInt(lastConvId);
                if (!isNaN(currentConvId)) {
                    cargarMensajes(currentConvId);
                }
            } else {
                currentConvId = data.conversations[0].id;
                cargarMensajes(currentConvId);
                localStorage.setItem('lastConvId', currentConvId);
            }
        } else if (data.conversations.length === 0) {
            mostrarMensajeBienvenida();
        }
    } catch (error) {
        handleFetchError(error, 'Carga de conversaciones');
    }
};

const cargarMensajes = async (convId) => {
    if (!convId) {
        console.warn("⚠️ No hay convId válido, no se pueden cargar mensajes.");
        return;
    }
    currentConvId = convId;

    try {
        const res = await fetch(`/messages/${convId}`);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();

        const container = getElement('#chatbox').querySelector('.message-container');
        container.innerHTML = '';

        data.messages.forEach(msg => {
            const div = document.createElement('div');
            div.classList.add(msg.role === 'user' ? 'user' : 'bot');
            div.innerHTML = (typeof marked !== 'undefined' ? marked.parse(msg.content) : msg.content) +
                `<button class="copy-btn" data-text="${msg.content.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(div);
        });

        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
    } catch (error) {
        handleFetchError(error, 'Carga de mensajes');
    }
};

const eliminarConversacion = async (convId) => {
    if (!confirm("¿Estás seguro de que quieres eliminar esta conversación?")) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            if (currentConvId === convId) {
                currentConvId = null;
                getElement('#chatbox').querySelector('.message-container').innerHTML = '';
                mostrarMensajeBienvenida();
            }
            cargarConversaciones();
            mostrarNotificacion('Conversación eliminada', 'success');
        } else {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Error al eliminar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Eliminación de conversación');
    }
};

const renombrarConversacion = async (convId) => {
    const nuevoNombre = prompt('Nuevo nombre para la conversación:');
    if (!nuevoNombre) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nuevoNombre })
        });
        if (res.ok) {
            cargarConversaciones();
            mostrarNotificacion('Conversación renombrada', 'success');
        } else {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Error al renombrar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Renombrar conversación');
    }
};

const sendMessage = async () => {
    const input = getElement('#input');
    const nivelBtn = getElement('#nivel-btn');
    if (!input || !nivelBtn) {
        console.error('Elementos #input o #nivel-btn no encontrados');
        mostrarNotificacion('Error: Elementos de entrada no encontrados', 'error');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) return;
    input.value = '';

    const container = getElement('#chatbox').querySelector('.message-container');
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(pregunta) : pregunta) +
        `<button class="copy-btn" data-text="${pregunta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(userDiv);
    const loadingDiv = showLoading();
    scrollToBottom();

    if (!currentConvId) {
        try {
            const res = await fetch('/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (!res.ok) throw new Error('Error al crear conversación: ' + res.status);
            const data = await res.json();
            currentConvId = data.id;
            await cargarConversaciones();
        } catch (error) {
            handleFetchError(error, 'Creación de conversación');
            hideLoading(loadingDiv);
            return;
        }
    }

    try {
        await fetch(`/messages/${currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: "user", content: pregunta })
        });
    } catch (error) {
        handleFetchError(error, 'Guardado de mensaje usuario');
        hideLoading(loadingDiv);
    }

    try {
        const res = await fetch('/buscar_respuesta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pregunta,
                historial: getHistorial(),
                nivel_explicacion: nivelBtn.textContent.trim().toLowerCase().includes('básica') ? 'basica' :
                                  nivelBtn.textContent.trim().toLowerCase().includes('ejemplos') ? 'ejemplos' : 'avanzada',
                conv_id: currentConvId
            })
        });
        if (!res.ok) throw new Error(`Error al procesar la solicitud: ${res.status}`);
        const data = await res.json();
        currentConvId = data.conv_id || currentConvId;

        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        addCopyButtonListeners();

        // Obtener API Key desde el servidor para Ready Player Me
        let rpmApiKey;
        try {
            const keyRes = await fetch('/get_rpm_api_key');
            if (!keyRes.ok) throw new Error(`Error al obtener la API Key: ${keyRes.statusText}`);
            const keyData = await keyRes.json();
            rpmApiKey = keyData.rpm_api_key;
        } catch (error) {
            console.error('Error al obtener RPM_API_KEY:', error);
            mostrarNotificacion('No se pudo obtener la clave para animación', 'error');
            // Continuar con audio TTS si la API falla
            speakText(data.respuesta);
            hideLoading(loadingDiv);
            return;
        }

        // Llamada a la API de Ready Player Me para animación
        try {
            const animationRes = await fetch('https://api.readyplayer.me/v1/animation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${rpmApiKey}`
                },
                body: JSON.stringify({ text: data.respuesta })
            });
            if (!animationRes.ok) throw new Error('Error al obtener animación de Ready Player Me');
            const animationData = await animationRes.json();
            const { audioUrl, visemes } = animationData;

            // Reproducir audio usando speakText
            speakText(data.respuesta, audioUrl);

            // Aplicar visemas (simplificado, depende del SDK de Ready Player Me)
            if (avatarModel && visemes) {
                let visemeIndex = 0;
                const visemeInterval = setInterval(() => {
                    if (visemeIndex >= visemes.length) {
                        clearInterval(visemeInterval);
                        return;
                    }
                    const viseme = visemes[visemeIndex];
                    console.log('Aplicando visema:', viseme); // Implementar lógica de visemas con SDK
                    visemeIndex++;
                }, 100); // Ajustar según la duración de los visemas
            }
        } catch (error) {
            console.error('Error en la API de Ready Player Me:', error);
            mostrarNotificacion('Error al obtener animación del avatar, usando audio TTS', 'error');
            speakText(data.respuesta); // Usar TTS como respaldo
        }

        // Actualizar historial y guardar mensaje
        const historial = getHistorial();
        historial.push({ pregunta, respuesta: data.respuesta });
        if (historial.length > 10) historial.shift();
        localStorage.setItem('historial', JSON.stringify(historial));
        await fetch(`/messages/${currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'bot', content: data.respuesta })
        });
        await cargarConversaciones();
    } catch (error) {
        handleFetchError(error, 'Envío de mensaje');
    } finally {
        hideLoading(loadingDiv);
    }
};

const nuevaConversacion = async () => {
    try {
        const res = await fetch('/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        currentConvId = data.id;
        getElement('#chatbox').querySelector('.message-container').innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
    } catch (error) {
        handleFetchError(error, 'Creación de nueva conversación');
    }
};

const vaciarChat = async () => {
    if (!currentConvId) return;
    await nuevaConversacion();
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', handleCopy);
        btn.addEventListener('click', handleCopy);
    });
};

const handleCopy = (event) => {
    const btn = event.currentTarget;
    const text = btn.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
        mostrarNotificacion('Texto copiado al portapapeles', 'success');
        btn.innerHTML = `<i class="fas fa-check"></i>`;
        setTimeout(() => btn.innerHTML = `<i class="fas fa-copy"></i>`, 2000);
    }).catch(err => {
        console.error('Error al copiar texto:', err);
        mostrarNotificacion('Error al copiar texto', 'error');
    });
};

const toggleDropdown = (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) {
        dropdownMenu.classList.toggle('active');
        console.log('Menú desplegable toggled:', dropdownMenu.classList.contains('active') ? 'abierto' : 'cerrado');
        if (event) event.stopPropagation();
    } else {
        console.error('Elemento .dropdown-menu no encontrado');
        mostrarNotificacion('Error: Menú de niveles no encontrado', 'error');
    }
};

const setNivelExplicacion = (nivel) => {
    console.log('setNivelExplicacion llamado con nivel:', nivel);
    if (!['basica', 'ejemplos', 'avanzada'].includes(nivel)) {
        console.error('Nivel inválido:', nivel);
        mostrarNotificacion('Error: Nivel inválido', 'error');
        return;
    }

    localStorage.setItem('nivelExplicacion', nivel);
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        const nivelText =
            nivel === 'basica' ? 'Explicación Básica' :
            nivel === 'ejemplos' ? 'Con Ejemplos de Código' :
            'Avanzada/Teórica';
        nivelBtn.innerHTML = `${nivelText} <i class="fas fa-caret-down"></i>`;
        console.log('Nivel actualizado a:', nivelText);

        const dropdownMenu = getElement('.dropdown-menu');
        if (dropdownMenu && dropdownMenu.classList.contains('active')) {
            dropdownMenu.classList.remove('active');
            console.log('Menú desplegable cerrado tras seleccionar nivel');
        }

        mostrarNotificacion(`Nivel cambiado a: ${nivelText}`, 'success');
    } else {
        console.error('Elemento #nivel-btn no encontrado');
        mostrarNotificacion('Error: Botón de nivel no encontrado', 'error');
    }
};

const isMobile = () => window.innerWidth < 768;

document.addEventListener('click', (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    const nivelBtn = getElement('#nivel-btn');

    if (nivelBtn && nivelBtn.contains(event.target)) {
        console.log('Clic en botón de nivel, toggling menú');
        return;
    }

    if (dropdownMenu && dropdownMenu.contains(event.target)) {
        console.log('Clic en opción del menú desplegable');
        return;
    }

    if (dropdownMenu && dropdownMenu.classList.contains('active')) {
        dropdownMenu.classList.remove('active');
        console.log('Menú desplegable cerrado por clic fuera');
    }

    if (isMobile()) {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');

        if (leftSection && leftSection.classList.contains('active') &&
            !leftSection.contains(event.target) &&
            !getElement('.menu-toggle').contains(event.target)) {
            toggleMenu();
        }

        if (rightSection && rightSection.classList.contains('active') &&
            !rightSection.contains(event.target) &&
            !getElement('.menu-toggle-right').contains(event.target)) {
            toggleRightMenu();
        }
    }
});

const toggleMenu = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    if (!leftSection) return;
    leftSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggle = getElement('.menu-toggle');
        menuToggle.innerHTML = leftSection.classList.contains('active')
            ? '<i class="fas fa-times"></i>'
            : '<i class="fas fa-bars"></i>';
    }

    if (rightSection && rightSection.classList.contains('active')) {
        rightSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && leftSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

const toggleRightMenu = () => {
    const rightSection = getElement('.right-section');
    const leftSection = getElement('.left-section');
    if (!rightSection) return;
    rightSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggleRight = getElement('.menu-toggle-right');
        menuToggleRight.innerHTML = rightSection.classList.contains('active')
            ? '<i class="fas fa-times"></i>'
            : '<i class="fas fa-bars"></i>';
    }

    if (leftSection && leftSection.classList.contains('active')) {
        leftSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && rightSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

const mostrarMensajeBienvenida = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        mostrarNotificacion('Error: Contenedor de chat no encontrado', 'error');
        return;
    }

    const mensaje = '👋 ¡Hola! Soy YELIA, tu asistente de Programación Avanzada en Ingeniería en Telemática. ¿Qué quieres aprender hoy?';
    
    if (container.children.length === 0) {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje, { breaks: true, gfm: true }) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();

        if (vozActiva && userHasInteracted) {
            speakText(mensaje);
        } else if (vozActiva) {
            pendingWelcomeMessage = mensaje;
        }
    }
};

const obtenerQuiz = async (tipo) => {
    console.log('Obteniendo quiz, tipo:', tipo);
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', nivel: localStorage.getItem('nivelExplicacion') || 'basica' })
        });
        if (!res.ok) throw new Error(`Error al obtener quiz: ${res.status}`);
        const data = await res.json();
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Obtención de quiz');
        hideLoading(loadingDiv);
        return null;
    }
};

const mostrarQuizEnChat = async (quizData) => {
    if (!quizData) return;
    console.log('Mostrando quiz en chat:', quizData);
    const container = getElement('#chatbox').querySelector('.message-container');
    const quizDiv = document.createElement('div');
    quizDiv.classList.add('bot');
    quizDiv.setAttribute('aria-live', 'polite');
    let optionsHtml = quizData.opciones.map((opcion, index) => `
        <div class="quiz-option" data-option="${opcion}" data-index="${index}" tabindex="0" role="button" aria-label="Opción ${opcion}">${opcion}</div>
    `).join('');
    quizDiv.innerHTML = `
        <p>${quizData.pregunta}</p>
        <div class="quiz-options">${optionsHtml}</div>
        <button class="copy-btn" data-text="${quizData.pregunta}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>
    `;
    quizDiv.dataset.respuestaCorrecta = quizData.respuesta_correcta;
    container.appendChild(quizDiv);
    scrollToBottom();

    getElements('.quiz-option').forEach(option => {
        option.removeEventListener('click', handleQuizOption);
        option.addEventListener('click', handleQuizOption);
        option.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') option.click();
        });
    });
    addCopyButtonListeners();
};

const handleQuizOption = async (event) => {
    const option = event.currentTarget;
    const selectedOption = option.dataset.option;
    const quizContainer = option.closest('.bot');
    const quizData = {
        pregunta: quizContainer.querySelector('p').textContent,
        opciones: Array.from(quizContainer.querySelectorAll('.quiz-option')).map(opt => opt.dataset.option),
        respuesta_correcta: quizContainer.dataset.respuestaCorrecta || '',
        tema: quizContainer.dataset.tema || 'unknown'
    };
    if (!quizData.respuesta_correcta) {
        console.error('No se proporcionó respuesta_correcta');
        mostrarNotificacion('Error: No se pudo determinar la respuesta correcta', 'error');
        return;
    }
    getElements('.quiz-option').forEach(opt => opt.classList.remove('selected', 'correct', 'incorrect'));
    option.classList.add('selected');
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/responder_quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pregunta: quizData.pregunta,
                respuesta: selectedOption,
                respuesta_correcta: quizData.respuesta_correcta,
                tema: quizData.tema
            })
        });
        if (!res.ok) throw new Error(`Error al responder quiz: ${res.status}`);
        const data = await res.json();
        const isCorrect = data.es_correcta;
        option.classList.add(isCorrect ? 'correct' : 'incorrect');
        if (!isCorrect) {
            const correctOption = quizContainer.querySelector(`.quiz-option[data-option="${data.respuesta_correcta}"]`);
            if (correctOption) correctOption.classList.add('correct');
        }
        hideLoading(loadingDiv);
        const container = getElement('#chatbox').querySelector('.message-container');
        const feedbackDiv = document.createElement('div');
        feedbackDiv.classList.add('bot');
        feedbackDiv.dataset.tema = quizData.tema;
        feedbackDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar respuesta"><i class="fas fa-copy"></i></button>`;
        container.appendChild(feedbackDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.respuesta);
        addCopyButtonListeners();

        const historial = getHistorial();
        historial.push({ pregunta: quizData.pregunta, respuesta: data.respuesta, tema: quizData.tema });
        if (historial.length > 10) historial.shift();
    } catch (error) {
        handleFetchError(error, 'Respuesta de quiz');
        hideLoading(loadingDiv);
    }
};

const obtenerRecomendacion = async () => {
    console.log('Obteniendo recomendación');
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: getHistorial() })
        });
        if (!res.ok) throw new Error(`Error al obtener recomendación: ${res.status}`);
        const data = await res.json();
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Obtención de recomendación');
        hideLoading(loadingDiv);
        return { recommendation: 'No se pudo generar recomendación' };
    }
};

const cargarTemas = async () => {
    const cacheKey = 'temasCache';
    const cacheTimeKey = 'temasCacheTime';
    const cacheDuration = 24 * 60 * 60 * 1000; // 24 horas
    const cachedTemas = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);

    if (cachedTemas && cachedTime && Date.now() - parseInt(cachedTime) < cacheDuration) {
        TEMAS_DISPONIBLES = JSON.parse(cachedTemas);
        console.log('Temas cargados desde caché:', TEMAS_DISPONIBLES);
        return;
    }

    try {
        const res = await fetch('/temas', { method: 'GET' });
        if (!res.ok) throw new Error(`Error al cargar temas: ${res.status}`);
        const data = await res.json();
        if (data.temas && Array.isArray(data.temas)) {
            TEMAS_DISPONIBLES = data.temas;
            localStorage.setItem(cacheKey, JSON.stringify(TEMAS_DISPONIBLES));
            localStorage.setItem(cacheTimeKey, Date.now().toString());
            console.log('Temas cargados desde servidor:', TEMAS_DISPONIBLES);
        } else {
            console.warn('No se pudieron cargar temas, usando lista por defecto');
        }
    } catch (error) {
        handleFetchError(error, 'Carga de temas');
        console.warn('Usando temas por defecto debido a error');
    }
};

// Configuración de la escena 3D para el avatar
let scene, camera, renderer, avatarModel;

async function setupAvatarScene() {
    try {
        const container = getElement('#avatar-container');
        if (!container) {
            console.error('Contenedor #avatar-container no encontrado');
            mostrarNotificacion('No se encontró el contenedor del avatar', 'error');
            return;
        }

        // Obtener API Key
        const keyRes = await fetch('/get_rpm_api_key');
        if (!keyRes.ok) throw new Error(`Error al obtener la API Key: ${keyRes.statusText}`);
        const keyData = await keyRes.json();
        const apiKey = keyData.rpm_api_key;

        // Crear escena, cámara y renderizador
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(renderer.domElement);

        // Añadir luces
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        // Cargar modelo GLB con autenticación
        const avatarUrl = `https://models.readyplayer.me/68ae2fecfa03635f0fbcbae8.glb?apiKey=${apiKey}`;
        const loader = new THREE.GLTFLoader();
        loader.load(
            avatarUrl,
            (gltf) => {
                avatarModel = gltf.scene;
                avatarModel.scale.set(1.5, 1.5, 1.5);
                avatarModel.position.set(0, -1, 0);
                scene.add(avatarModel);
                console.log('Modelo GLB cargado:', avatarUrl);
                container.classList.remove('error', 'loading');
                animate();
            },
            (xhr) => {
                const percentComplete = (xhr.loaded / xhr.total) * 100;
                console.log(`Cargando avatar: ${percentComplete}%`);
                container.classList.add('loading');
            },
            (error) => {
                console.error('Error al cargar el modelo GLB:', error);
                mostrarNotificacion('Error al cargar el avatar 3D', 'error');
                container.classList.add('error');
            }
        );

        // Posicionar cámara
        camera.position.z = 2;

        // Manejar redimensionamiento
        window.addEventListener('resize', () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            renderer.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        });

        // Animación
        function animate() {
            requestAnimationFrame(animate);
            renderer.render(scene, camera);
        }
    } catch (error) {
        console.error('Error en setupAvatarScene:', error);
        mostrarNotificacion('Error al inicializar el avatar 3D', 'error');
        const container = getElement('#avatar-container');
        if (container) {
            container.classList.add('error');
        }
    }
}
const init = () => {
    console.log('Inicializando aplicación');
    quizHistory = JSON.parse(localStorage.getItem('quizHistory') || '[]');

    cargarTemas();

    const menuToggle = getElement('.menu-toggle');
    const menuToggleRight = getElement('.menu-toggle-right');
    const modoBtn = getElement('#modo-btn');
    const voiceBtn = getElement('#voice-btn');
    const quizBtn = getElement('#quiz-btn');
    const recommendBtn = getElement('#recommend-btn');
    const sendBtn = getElement('#send-btn');
    const newChatBtn = getElement('#new-chat-btn');
    const clearBtn = getElement('#btn-clear');
    const nivelBtn = getElement('#nivel-btn');
    const voiceToggleBtn = getElement('#voice-toggle-btn');

    if (menuToggle) {
        menuToggle.removeEventListener('click', toggleMenu);
        menuToggle.addEventListener('click', toggleMenu);
        menuToggle.setAttribute('data-tooltip', 'Menú Izquierdo');
        menuToggle.setAttribute('aria-label', 'Abrir menú izquierdo');
    }
    if (menuToggleRight) {
        menuToggleRight.removeEventListener('click', toggleRightMenu);
        menuToggleRight.addEventListener('click', toggleRightMenu);
        menuToggleRight.setAttribute('data-tooltip', 'Menú Derecho');
        menuToggleRight.setAttribute('aria-label', 'Abrir menú derecho');
    }
    if (modoBtn) {
        const modoOscuro = localStorage.getItem('modoOscuro') === 'true';
        modoBtn.setAttribute('data-tooltip', modoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
        modoBtn.setAttribute('aria-label', modoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
        modoBtn.innerHTML = `
            <i class="fas ${modoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${modoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
        `;
        modoBtn.removeEventListener('click', handleModoToggle);
        modoBtn.addEventListener('click', debounce(handleModoToggle, 300));
    }
    if (voiceBtn) {
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
        voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
        voiceBtn.innerHTML = `
            <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
        `;
        voiceBtn.removeEventListener('click', handleVoiceToggle);
        voiceBtn.addEventListener('click', handleVoiceToggle);
    }
    if (quizBtn) {
        quizBtn.setAttribute('data-tooltip', 'Obtener Quiz');
        quizBtn.setAttribute('aria-label', 'Generar un quiz');
        quizBtn.removeEventListener('click', handleQuizClick);
        quizBtn.addEventListener('click', debounce(handleQuizClick, 300));
    }
    if (recommendBtn) {
        recommendBtn.setAttribute('data-tooltip', 'Obtener Recomendación');
        recommendBtn.setAttribute('aria-label', 'Obtener recomendación de tema');
        recommendBtn.removeEventListener('click', handleRecommendClick);
        recommendBtn.addEventListener('click', debounce(handleRecommendClick, 300));
    }
    if (sendBtn) {
        sendBtn.setAttribute('data-tooltip', 'Enviar');
        sendBtn.setAttribute('aria-label', 'Enviar mensaje');
        sendBtn.removeEventListener('click', sendMessage);
        sendBtn.addEventListener('click', debounce(sendMessage, 300));
    }
    if (newChatBtn) {
        newChatBtn.setAttribute('data-tooltip', 'Nuevo Chat');
        newChatBtn.setAttribute('aria-label', 'Iniciar nueva conversación');
        newChatBtn.removeEventListener('click', nuevaConversacion);
        newChatBtn.addEventListener('click', debounce(nuevaConversacion, 300));
    }
    if (clearBtn) {
        clearBtn.setAttribute('data-tooltip', 'Limpiar Chat');
        clearBtn.setAttribute('aria-label', 'Limpiar chat actual');
        clearBtn.removeEventListener('click', nuevaConversacion);
        clearBtn.addEventListener('click', debounce(nuevaConversacion, 300));
    }
    if (nivelBtn) {
        nivelBtn.setAttribute('data-tooltip', 'Cambiar Nivel');
        nivelBtn.setAttribute('aria-label', 'Cambiar nivel de explicación');
        nivelBtn.removeEventListener('click', toggleDropdown);
        nivelBtn.addEventListener('click', toggleDropdown);
    }
    if (voiceToggleBtn) {
        voiceToggleBtn.setAttribute('data-tooltip', 'Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        voiceToggleBtn.removeEventListener('click', toggleVoiceRecognition);
        voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }
    const inputElement = getElement('#input');
    if (inputElement) {
        inputElement.removeEventListener('keydown', handleInputKeydown);
        inputElement.addEventListener('keydown', handleInputKeydown);
    }

    // Inicializar escena del avatar
    try {
        setupAvatarScene();
    } catch (error) {
        console.error('Error al inicializar setupAvatarScene:', error);
        mostrarNotificacion('Error al inicializar el avatar 3D', 'error');
    }

    setTimeout(() => {
        mostrarMensajeBienvenida();
        if (vozActiva && !userHasInteracted) {
            toggleVoiceHint(true);
        }
    }, 100);
    document.removeEventListener('click', handleFirstInteraction);
    document.removeEventListener('touchstart', handleFirstInteraction);
    document.addEventListener('click', handleFirstInteraction, { once: true });
    document.addEventListener('touchstart', handleFirstInteraction, { once: true });
    cargarConversaciones();

    let nivelGuardado = localStorage.getItem('nivelExplicacion');
    if (!['basica', 'ejemplos', 'avanzada'].includes(nivelGuardado)) {
        nivelGuardado = 'basica';
        localStorage.setItem('nivelExplicacion', nivelGuardado);
    }
    console.log('Nivel guardado en localStorage:', nivelGuardado);
    setNivelExplicacion(nivelGuardado);
};

const handleModoToggle = () => {
    document.body.classList.toggle('modo-oscuro');
    const isModoOscuro = document.body.classList.contains('modo-oscuro');
    localStorage.setItem('modoOscuro', isModoOscuro);
    const modoBtn = getElement('#modo-btn');
    modoBtn.setAttribute('data-tooltip', isModoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
    modoBtn.setAttribute('aria-label', isModoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    modoBtn.innerHTML = `
        <i class="fas ${isModoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
        <span id="modo-text">${isModoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
    `;
    mostrarNotificacion(`Modo ${isModoOscuro ? 'oscuro' : 'claro'} activado`, 'success');
};

const handleVoiceToggle = () => {
    vozActiva = !vozActiva;
    localStorage.setItem('vozActiva', vozActiva);
    const voiceBtn = getElement('#voice-btn');
    voiceBtn.innerHTML = `
        <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
        <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
    `;
    voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
    voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
    mostrarNotificacion(`Audio ${vozActiva ? 'activado' : 'desactivado'}`, 'success');
    if (!vozActiva) stopSpeech();
    if (vozActiva && !userHasInteracted) toggleVoiceHint(true);
};

const handleQuizClick = () => {
    console.log('Botón de quiz clickeado');
    obtenerQuiz('opciones').then(mostrarQuizEnChat);
};

const handleRecommendClick = async () => {
    console.log('Botón de recomendación clickeado, iniciando proceso');
    const usuario = sessionStorage.getItem('usuario') || 'anonimo';
    const historial = getHistorial();
    const convId = currentConvId;
    const loadingDiv = showLoading();
    try {
        console.log('Enviando solicitud a /recommend', { usuario, historial, convId });
        const res = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, historial })
        });
        console.log('Respuesta recibida de /recommend', { status: res.status });
        if (!res.ok) {
            const errData = await res.json();
            throw new Error(`Error al obtener recomendación: ${res.status} - ${errData.error || res.statusText}`);
        }
        const data = await res.json();
        console.log('Datos recibidos:', data);
        currentConvId = data.conv_id || currentConvId;
        const mensaje = data.recommendation;
        if (!mensaje) throw new Error('No se recibió recomendación válida');
        const tema = mensaje.match(/Te recomiendo estudiar: (.*)/)?.[1] || '';
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.dataset.tema = tema;
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        const container = getElement('#chatbox').querySelector('.message-container');
        if (!container) {
            console.error('Contenedor .message-container no encontrado');
            mostrarNotificacion('Error: No se encontró el contenedor del chat', 'error');
            return;
        }
        container.appendChild(botDiv);
        scrollToBottom();
        speakText(mensaje);
        addCopyButtonListeners();
        if (currentConvId) {
            console.log('Guardando mensaje en /messages/', currentConvId);
            await fetch(`/messages/${currentConvId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role: 'bot',
                    content: mensaje,
                    tema: tema
                })
            });
            console.log('Actualizando historial de chats');
            await cargarConversaciones();
        } else {
            console.warn('No hay currentConvId, no se puede guardar el mensaje');
            mostrarNotificacion('No se pudo guardar la conversación', 'error');
        }
        historial.push({ pregunta: '', respuesta: mensaje, tema });
        if (historial.length > 10) historial.shift();
        localStorage.setItem('historial', JSON.stringify(historial));
        console.log('Historial actualizado y guardado en localStorage');
    } catch (error) {
        console.error('Error en handleRecommendClick:', error);
        handleFetchError(error, 'Obtener recomendación');
        mostrarNotificacion(`Error al obtener recomendación: ${error.message}`, 'error');
    } finally {
        hideLoading(loadingDiv);
    }
};

const handleInputKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
};

const handleFirstInteraction = () => {
    if (!userHasInteracted) {
        userHasInteracted = true;
        toggleVoiceHint(false);
        console.log('Interacción detectada, audio habilitado');
        if (pendingWelcomeMessage) {
            speakText(pendingWelcomeMessage);
            pendingWelcomeMessage = null;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    init();
});