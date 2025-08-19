let vozActiva = localStorage.getItem('vozActiva') === 'true' || false;
let isListening = false;
let recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;

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

const mostrarNotificacion = (mensaje, tipo = 'info') => {
    const card = getElement('#notification-card');
    if (!card) {
        console.error('Elemento #notification-card no encontrado');
        return;
    }
    card.innerHTML = `
        <p>${mensaje}</p>
        <button onclick="this.parentElement.classList.remove('active')" aria-label="Cerrar notificación">Cerrar</button>
    `;
    card.classList.add('active', tipo);
    card.style.animation = 'fadeIn 0.5s ease-out';
    setTimeout(() => {
        card.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => card.classList.remove('active', tipo), 500);
    }, 5000);
};

const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (voiceHint) {
        voiceHint.style.display = show ? 'block' : 'none';
        voiceHint.classList.toggle('hidden', !show);
    }
};

const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    requestAnimationFrame(() => {
        chatbox.scrollTop = chatbox.scrollHeight;
        const lastMessage = container.lastElementChild;
        if (lastMessage) {
            lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    });
};

const updateAvatarDisplay = () => {
    const avatarImg = getElement('#avatar-img');
    if (!avatarImg) return;
    const avatars = JSON.parse(localStorage.getItem('avatars') || '[]');
    const selected = avatars.find(a => a.avatar_id === selectedAvatar) || { url: '/static/img/default-avatar.png' };
    avatarImg.src = selected.url;
    avatarImg.classList.add('animate-avatar');
    setTimeout(() => avatarImg.classList.remove('animate-avatar'), 300);
};

const speakText = text => {
    if (!vozActiva || !text) {
        console.warn('Voz desactivada o texto vacío, no se reproduce voz', { vozActiva, text });
        return;
    }
    if (!userHasInteracted) {
        console.warn('No se puede reproducir audio: el usuario no ha interactuado con la página');
        toggleVoiceHint(true);
        return;
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en TTS: ${res.status} ${res.statusText}`);
            });
        }
        return res.blob();
    }).then(blob => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play().catch(error => {
            console.error('Error al reproducir audio:', error);
            if (error.message.includes("user didn't interact")) {
                console.warn('Intento de reproducción bloqueado por falta de interacción');
                toggleVoiceHint(true);
            } else {
                mostrarNotificacion('Error al reproducir voz de IA: ' + error.message, 'error');
            }
        });
        currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
        };
    }).catch(error => {
        console.error('TTS /tts falló, intentando speechSynthesis', error.message);
        mostrarNotificacion(`Error en TTS: ${error.message}`, 'error');
        if ('speechSynthesis' in window && userHasInteracted) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'es-ES';
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
            };
            utterance.onerror = (event) => {
                console.error('Error en speechSynthesis:', event.error);
                if (event.error !== 'not-allowed') {
                    mostrarNotificacion('Error en voz de IA: ' + event.error, 'error');
                } else {
                    toggleVoiceHint(true);
                }
            };
            speechSynthesis.speak(utterance);
            currentAudio = utterance;
        } else {
            console.warn('No se puede usar speechSynthesis: sin soporte o sin interacción');
        }
    });
};

const stopSpeech = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    }
    if (isListening && recognition) {
        try {
            recognition.stop();
            isListening = false;
            if (voiceToggleBtn) {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
            mostrarNotificacion('Reconocimiento de voz detenido', 'info');
        } catch (error) {
            mostrarNotificacion(`Error al detener voz: ${error.message}`, 'error');
            console.error('Error al detener reconocimiento de voz:', error);
        }
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) {
        console.error('Botón #voice-toggle-btn no encontrado');
        mostrarNotificacion('Error: No se encontró el botón de reconocimiento de voz', 'error');
        return;
    }
    if (!isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado en este navegador', 'error');
            return;
        }
        recognition = ('webkitSpeechRecognition' in window) ? new webkitSpeechRecognition() : new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.continuous = true;
        recognition.start();
        isListening = true;
        voiceToggleBtn.classList.add('voice-active');
        voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
        voiceToggleBtn.setAttribute('data-tooltip', 'Detener reconocimiento de voz');
        voiceToggleBtn.setAttribute('aria-label', 'Detener reconocimiento de voz');
        mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        recognition.onresult = event => {
            const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            const input = getElement('#input');
            if (input) input.value = transcript;
            if (event.results[event.results.length - 1].isFinal) {
                sendMessage();
                recognition.stop();
                isListening = false;
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        recognition.onerror = event => {
            mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
            console.error('Error en reconocimiento de voz:', event.error);
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
            } else {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
    } else {
        stopSpeech();
    }
};

const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) {
        console.error('Elemento .avatar-options no encontrado');
        return;
    }
    try {
        const response = await fetch('/avatars', { cache: 'no-store' });
        let avatares = [];
        if (response.ok) {
            avatares = await response.json();
        } else {
            avatares = [
                { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }
            ];
            console.warn('Usando avatares estáticos por fallo en /avatars');
        }
        localStorage.setItem('avatars', JSON.stringify(avatares));
        avatarContainer.innerHTML = '';
        avatares.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.classList.add('avatar-option');
            img.dataset.avatar = avatar.avatar_id;
            img.alt = `Avatar ${avatar.nombre}`;
            img.title = avatar.nombre;
            if (avatar.avatar_id === selectedAvatar) img.classList.add('selected');
            avatarContainer.appendChild(img);
            img.addEventListener('click', () => {
                getElements('.avatar-option').forEach(opt => opt.classList.remove('selected'));
                img.classList.add('selected');
                selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                updateAvatarDisplay();
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
        updateAvatarDisplay();
    } catch (error) {
        mostrarNotificacion(`Error al cargar avatares: ${error.message}`, 'error');
        console.error('Error al cargar avatares:', error);
        const fallbackAvatares = [
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }
        ];
        localStorage.setItem('avatars', JSON.stringify(fallbackAvatares));
        avatarContainer.innerHTML = '';
        fallbackAvatares.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.classList.add('avatar-option');
            img.dataset.avatar = avatar.avatar_id;
            img.alt = `Avatar ${avatar.nombre}`;
            img.title = avatar.nombre;
            if (avatar.avatar_id === selectedAvatar) img.classList.add('selected');
            avatarContainer.appendChild(img);
            img.addEventListener('click', () => {
                getElements('.avatar-option').forEach(opt => opt.classList.remove('selected'));
                img.classList.add('selected');
                selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                updateAvatarDisplay();
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
        updateAvatarDisplay();
    }
};

const guardarMensaje = (pregunta, respuesta, video_url = null, tema = null) => {
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
        const newId = historial.length;
        currentConversation = {
            id: newId,
            nombre: `Chat ${new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`,
            timestamp: Date.now(),
            mensajes: []
        };
        historial.push({
            id: newId,
            nombre: currentConversation.nombre,
            timestamp: currentConversation.timestamp,
            mensajes: []
        });
        localStorage.setItem('chatHistory', JSON.stringify(historial));
    }
    currentConversation.mensajes.push({ pregunta, respuesta, video_url, tema });
    if (currentConversation.mensajes.length > 5) {
        currentConversation.mensajes = currentConversation.mensajes.slice(-5);
    }
    localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    historial[currentConversation.id] = {
        id: currentConversation.id,
        nombre: currentConversation.nombre,
        timestamp: currentConversation.timestamp,
        mensajes: currentConversation.mensajes
    };
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
    scrollToBottom();
};

const actualizarListaChats = () => {
    const chatList = getElement('#chat-list');
    if (!chatList) {
        console.error('Elemento #chat-list no encontrado');
        return;
    }
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`}</span>
                        <div class="chat-actions">
                            <button class="rename-btn" data-tooltip="Renombrar chat" aria-label="Renombrar chat"><i class="fas fa-edit"></i></button>
                            <button class="delete-btn" data-tooltip="Eliminar chat" aria-label="Eliminar chat"><i class="fas fa-trash"></i></button>
                        </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`);
        li.tabIndex = 0; // Para soporte de teclado
        chatList.appendChild(li);
        li.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON' && !e.target.closest('.chat-actions')) {
                cargarChat(index);
            }
        });
        li.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                cargarChat(index);
            }
        });
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => eliminarChat(index));
    });
    requestAnimationFrame(() => {
        chatList.scrollTop = chatList.scrollHeight;
    });
};

const cargarChat = index => {
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const chat = historial[index];
    if (!chat) {
        console.error(`Chat con índice ${index} no encontrado`);
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = chat.mensajes.map(msg => `
        <div class="user">${msg.pregunta}</div>
        <div class="bot">${typeof marked !== 'undefined' ? marked.parse(msg.respuesta) : msg.respuesta}
            <button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>
        </div>
    `).join('');
    scrollToBottom();
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, nombre: chat.nombre, timestamp: chat.timestamp, mensajes: chat.mensajes }));
    getElements('#chat-list li').forEach(li => li.classList.remove('selected'));
    getElement(`#chat-list li[data-index="${index}"]`)?.classList.add('selected');
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const renombrarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado para renombrar`);
        return;
    }
    const nuevoNombre = prompt('Nuevo nombre para el chat:', historial[index].nombre);
    if (nuevoNombre) {
        historial[index].nombre = nuevoNombre;
        localStorage.setItem('chatHistory', JSON.stringify(historial));
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        if (currentConversation.id === index) {
            currentConversation.nombre = nuevoNombre;
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
        }
        actualizarListaChats();
        mostrarNotificacion('Chat renombrado con éxito', 'success');
    }
};

const eliminarChat = index => {
    if (!confirm('¿Eliminar este chat?')) return;
    let historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado en chatHistory`, historial);
        mostrarNotificacion(`Error: Chat con índice ${index} no encontrado`, 'error');
        return;
    }
    historial.splice(index, 1);
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id === index) {
        localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        mostrarNotificacion('Chat eliminado, conversación limpiada', 'info');
    }
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
};

const cargarAnalytics = async () => {
    const analyticsContainer = getElement('#analytics');
    if (!analyticsContainer) {
        console.error('Elemento #analytics no encontrado');
        return;
    }
    try {
        const response = await fetch('/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo' }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /analytics: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        analyticsContainer.innerHTML = data.map(item => `<p>${item.tema}: Tasa de acierto ${item.tasa_acierto * 100}%</p>`).join('');
    } catch (error) {
        console.warn('Error en fetch /analytics, usando datos de prueba:', error);
        const datosPrueba = [
            { tema: 'POO', tasa_acierto: 0.85 },
            { tema: 'Estructuras de Datos', tasa_acierto: 0.70 }
        ];
        analyticsContainer.innerHTML = datosPrueba.map(item => `<p>${item.tema}: Tasa de acierto ${item.tasa_acierto * 100}%</p>`).join('');
        mostrarNotificacion('Analytics no disponible, mostrando datos de prueba', 'info');
    }
};

const obtenerRecomendacion = async () => {
    try {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const contexto = currentConversation.mensajes || [];
        const response = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: contexto }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /recommend: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.warn('Error en fetch /recommend, generando recomendación simulada:', error);
        return { recommendation: 'Patrones de diseño' };
    }
};

const obtenerQuiz = async (tipoQuiz = 'opciones') => {
    try {
        const response = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', tema: 'POO', tipo_quiz: tipoQuiz }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /quiz: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.warn('Error en fetch /quiz, generando quiz simulado:', error);
        return {
            quiz: [{
                pregunta: tipoQuiz === 'verdadero_falso' ? 'La encapsulación permite ocultar datos.' : '¿Qué es la encapsulación en POO?',
                opciones: tipoQuiz === 'verdadero_falso' ? ['Verdadero', 'Falso'] : ['Ocultar datos', 'Herencia', 'Polimorfismo', 'Abstracción'],
                respuesta_correcta: tipoQuiz === 'verdadero_falso' ? 'Verdadero' : 'Ocultar datos',
                tema: 'POO',
                nivel: 'basico'
            }]
        };
    }
};

const sendMessage = () => {
    const input = getElement('#input');
    const nivelExplicacion = getElement('#nivel-explicacion')?.value || 'basica';
    if (!input) {
        console.error('Elemento #input no encontrado');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) {
        return; // Ignorar mensajes vacíos sin mostrar error
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    input.value = '';
    scrollToBottom();
    const historial = JSON.parse(localStorage.getItem('currentConversation') || '{}').mensajes || [];
    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, usuario: 'anonimo', avatar_id: selectedAvatar, nivel_explicacion: nivelExplicacion, historial })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /respuesta: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(data.respuesta);
        guardarMensaje(pregunta, data.respuesta, data.video_url);
        addCopyButtonListeners();
    }).catch(error => {
        mostrarNotificacion(`Error al obtener respuesta: ${error.message}`, 'error');
        console.error('Error en fetch /respuesta:', error);
    });
};

const limpiarChat = () => {
    stopSpeech();
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = '';
    localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
    mostrarNotificacion('Chat limpiado', 'success');
};

const nuevaConversacion = () => {
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const newId = historial.length;
    const newConversation = {
        id: newId,
        nombre: `Chat ${new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`,
        timestamp: Date.now(),
        mensajes: []
    };
    historial.push(newConversation);
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    localStorage.setItem('currentConversation', JSON.stringify(newConversation));
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container) container.innerHTML = '';
    actualizarListaChats();
    mostrarNotificacion('Nueva conversación iniciada', 'success');
};

const buscarTema = () => {
    const searchInput = getElement('#search-input');
    if (!searchInput) {
        console.error('Elemento #search-input no encontrado');
        return;
    }
    const tema = searchInput.value.trim();
    if (!tema) {
        mostrarNotificacion('Por favor, escribe un tema para buscar.', 'error');
        return;
    }
    const input = getElement('#input');
    if (input) {
        input.value = `Explica ${tema} en el contexto de programación avanzada`;
        sendMessage();
    }
};

const responderQuiz = (opcion, respuestaCorrecta, tema) => {
    fetch('/responder_quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: 'anonimo', respuesta: opcion, respuesta_correcta: respuestaCorrecta, tema })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /responder_quiz: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (!container || !chatbox) return;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        const icono = data.es_correcta ? '<span class="quiz-feedback correct">✅</span>' : '<span class="quiz-feedback incorrect">❌</span>';
        botDiv.innerHTML = icono + (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(data.respuesta);
        guardarMensaje(`Respuesta al quiz sobre ${tema}`, data.respuesta);
        addCopyButtonListeners();
        getElement('#quiz-modal').style.display = 'none';
    }).catch(error => {
        mostrarNotificacion(`Error al responder quiz: ${error.message}`, 'error');
        console.error('Error en fetch /responder_quiz:', error);
    });
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', btn._copyHandler); // Evitar duplicados
        btn._copyHandler = () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado al portapapeles', 'success');
            }).catch(error => {
                mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
                console.error('Error al copiar texto:', error);
            });
        };
        btn.addEventListener('click', btn._copyHandler);
    });
};

// Registrar interacción del usuario
document.addEventListener('click', () => {
    if (!userHasInteracted) {
        userHasInteracted = true;
        toggleVoiceHint(false);
        if (vozActiva && pendingWelcomeMessage) {
            speakText(pendingWelcomeMessage);
            pendingWelcomeMessage = null;
        }
    }
});

// Soporte de teclado
document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement === getElement('#input')) {
        e.preventDefault();
        sendMessage();
    } else if (e.key === 'Escape') {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');
        const quizModal = getElement('#quiz-modal');
        if (leftSection?.classList.contains('active')) {
            leftSection.classList.remove('active');
            getElement('.menu-toggle').innerHTML = `<i class="fas fa-bars"></i>`;
            getElement('.menu-toggle').setAttribute('aria-expanded', 'false');
        }
        if (rightSection?.classList.contains('active')) {
            rightSection.classList.remove('active');
            getElement('.menu-toggle-right').innerHTML = `<i class="fas fa-bars"></i>`;
            getElement('.menu-toggle-right').setAttribute('aria-expanded', 'false');
        }
        if (quizModal?.style.display === 'block') {
            quizModal.style.display = 'none';
        }
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        sendBtn: getElement('#send-btn'),
        recommendBtn: getElement('#recommend-btn'),
        quizBtn: getElement('#quiz-btn'),
        newChatBtn: getElement('#new-chat-btn'),
        clearBtn: getElement('#btn-clear'),
        voiceBtn: getElement('#voice-btn'),
        voiceToggleBtn: getElement('#voice-toggle-btn'),
        modoBtn: getElement('#modo-btn'),
        searchBtn: getElement('#search-btn'),
        searchInput: getElement('#search-input'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        tabButtons: getElements('.tab-btn'),
        nivelExplicacion: getElement('#nivel-explicacion')
    };

    // Persistir nivel de explicación
    if (elements.nivelExplicacion) {
        const savedNivel = localStorage.getItem('nivelExplicacion') || 'basica';
        elements.nivelExplicacion.value = savedNivel;
        elements.nivelExplicacion.addEventListener('change', () => {
            localStorage.setItem('nivelExplicacion', elements.nivelExplicacion.value);
        });
    }

    cargarAvatares();
    actualizarListaChats();
    cargarAnalytics();

    if (vozActiva) {
        toggleVoiceHint(true);
    }

    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container && chatbox) {
        fetch(`/saludo_inicial?avatar_id=${selectedAvatar}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        }).then(res => {
            if (!res.ok) {
                return res.json().then(err => {
                    throw new Error(err.error || `Error en /saludo_inicial: ${res.status} ${res.statusText}`);
                });
            }
            return res.json();
        }).then(data => {
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(botDiv);
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(botDiv);
            pendingWelcomeMessage = data.respuesta;
            guardarMensaje('Saludo inicial', data.respuesta, data.video_url);
            addCopyButtonListeners();
        }).catch(error => {
            mostrarNotificacion(`Error al cargar mensaje inicial: ${error.message}`, 'error');
            console.error('Error en fetch /saludo_inicial:', error);
        });
    }

    if (elements.sendBtn) {
        elements.sendBtn.addEventListener('click', sendMessage);
    }

    if (elements.recommendBtn) {
        elements.recommendBtn.addEventListener('click', async () => {
            const data = await obtenerRecomendacion();
            const chatbox = getElement('#chatbox');
            const container = chatbox?.querySelector('.message-container');
            if (!container || !chatbox) return;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            const recomendacion = `Te recomiendo estudiar: ${data.recommendation}`;
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(recomendacion) : recomendacion) + `<button class="copy-btn" data-text="${recomendacion}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(botDiv);
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(botDiv);
            speakText(recomendacion);
            guardarMensaje('Recomendación', recomendacion);
            addCopyButtonListeners();
        });
    }

    if (elements.quizBtn) {
        elements.quizBtn.addEventListener('click', async () => {
            const tipoQuiz = Math.random() < 0.5 ? 'opciones' : 'verdadero_falso';
            const data = await obtenerQuiz(tipoQuiz);
            const quizModal = getElement('#quiz-modal');
            const quizQuestion = getElement('#quiz-question');
            const quizOptions = getElement('#quiz-options');
            if (!quizModal || !quizQuestion || !quizOptions) return;
            const quiz = data.quiz[0];
            quizQuestion.textContent = quiz.pregunta;
            quizOptions.innerHTML = quiz.opciones.map((opcion, i) => `
                <button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${quiz.respuesta_correcta}" data-tema="${quiz.tema}">
                    ${tipoQuiz === 'verdadero_falso' ? opcion : `${i + 1}. ${opcion}`}
                </button>
            `).join('');
            quizModal.style.display = 'block';
            getElements('.quiz-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    getElements('.quiz-option').forEach(opt => opt.classList.remove('selected'));
                    btn.classList.add('selected');
                });
            });
            getElement('#quiz-submit')?.addEventListener('click', () => {
                const selectedOption = getElement('.quiz-option.selected');
                if (!selectedOption) {
                    mostrarNotificacion('Por favor, selecciona una opción.', 'error');
                    return;
                }
                const opcion = selectedOption.dataset.opcion;
                const respuestaCorrecta = selectedOption.dataset.respuestaCorrecta;
                const tema = selectedOption.dataset.tema;
                responderQuiz(opcion, respuestaCorrecta, tema);
            });
            guardarMensaje('Quiz', `${quiz.pregunta}\nOpciones: ${quiz.opciones.join(', ')}`);
        });
    }

    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener('click', nuevaConversacion);
    }

    if (elements.clearBtn) {
        elements.clearBtn.addEventListener('click', limpiarChat);
    }

    if (elements.voiceBtn) {
        elements.voiceBtn.addEventListener('click', () => {
            vozActiva = !vozActiva;
            localStorage.setItem('vozActiva', vozActiva);
            elements.voiceBtn.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
            mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
            if (!vozActiva) {
                stopSpeech();
                toggleVoiceHint(false);
            } else {
                toggleVoiceHint(!userHasInteracted);
                if (pendingWelcomeMessage && userHasInteracted) {
                    speakText(pendingWelcomeMessage);
                    pendingWelcomeMessage = null;
                }
            }
        });
    }

    if (elements.voiceToggleBtn) {
        elements.voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-oscuro');
            const modo = document.body.classList.contains('modo-oscuro') ? 'Oscuro' : 'Claro';
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            localStorage.setItem('theme', modo.toLowerCase());
            mostrarNotificacion(`Modo ${modo} activado`, 'success');
        });
    }

    if (elements.searchBtn) {
        elements.searchBtn.addEventListener('click', buscarTema);
    }

    if (elements.searchInput) {
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                buscarTema();
            }
        });
    }

    if (elements.menuToggle && elements.menuToggleRight) {
        const toggleLeftMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (leftSection) {
                leftSection.classList.toggle('active');
                elements.menuToggle.innerHTML = `<i class="fas fa-${leftSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                elements.menuToggle.setAttribute('aria-expanded', leftSection.classList.contains('active'));
                if (rightSection && rightSection.classList.contains('active') && window.innerWidth <= 768) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                    elements.menuToggleRight.setAttribute('aria-expanded', 'false');
                }
            }
        };

        const toggleRightMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rightSection = getElement('.right-section');
            const leftSection = getElement('.left-section');
            if (rightSection) {
                rightSection.classList.toggle('active');
                elements.menuToggleRight.innerHTML = `<i class="fas fa-${rightSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                elements.menuToggleRight.setAttribute('aria-expanded', rightSection.classList.contains('active'));
                if (leftSection && leftSection.classList.contains('active') && window.innerWidth <= 768) {
                    leftSection.classList.remove('active');
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                    elements.menuToggle.setAttribute('aria-expanded', 'false');
                }
            }
        };

        elements.menuToggle.addEventListener('click', toggleLeftMenu);
        elements.menuToggle.addEventListener('touchstart', toggleLeftMenu, { passive: false });
        elements.menuToggleRight.addEventListener('click', toggleRightMenu);
        elements.menuToggleRight.addEventListener('touchstart', toggleRightMenu, { passive: false });

        const closeMenusOnOutsideInteraction = (e) => {
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (window.innerWidth <= 768) {
                if (leftSection && leftSection.classList.contains('active') &&
                    !leftSection.contains(e.target) &&
                    !elements.menuToggle.contains(e.target)) {
                    leftSection.classList.remove('active');
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                    elements.menuToggle.setAttribute('aria-expanded', 'false');
                }
                if (rightSection && rightSection.classList.contains('active') &&
                    !rightSection.contains(e.target) &&
                    !elements.menuToggleRight.contains(e.target)) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                    elements.menuToggleRight.setAttribute('aria-expanded', 'false');
                }
            }
        };

        document.addEventListener('click', closeMenusOnOutsideInteraction);
        document.addEventListener('touchstart', closeMenusOnOutsideInteraction, { passive: false });
    }

    if (elements.tabButtons.length) {
        elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                elements.tabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
                getElement(`.${btn.dataset.tab}`)?.classList.add('active');
            });
        });
    }

    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'oscuro') {
        document.body.classList.add('modo-oscuro');
        if (elements.modoBtn) elements.modoBtn.innerHTML = `<i class="fas fa-sun"></i>`;
    } else {
        document.body.classList.remove('modo-oscuro');
        if (elements.modoBtn) elements.modoBtn.innerHTML = `<i class="fas fa-moon"></i>`;
    }
});