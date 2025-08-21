let vozActiva = localStorage.getItem('vozActiva') === 'true';
let isListening = false;
let recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;
let lastVoiceHintTime = 0;

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

const speakText = async (text) => {
    console.log('Intentando reproducir audio:', { vozActiva, text, userHasInteracted });
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
    let textoParaVoz = text
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/#+\s*/g, '')
        .replace(/-\s*/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\bYELIA\b/g, 'Yelia')
        .trim();
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
        console.log('Enviando solicitud al endpoint /tts');
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
    } catch (error) {
        console.error('Fallo en /tts, intentando speechSynthesis:', error);
        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            const esVoice = voices.find(v => v.lang.includes('es'));
            if (!esVoice) {
                console.warn('No se encontró voz en español');
                mostrarNotificacion('No se encontró voz en español', 'error');
                if (botMessage) botMessage.classList.remove('speaking');
                return;
            }
            const utterance = new SpeechSynthesisUtterance(textoParaVoz);
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
                mostrarNotificacion('Error en audio local: ' + event.error, 'error');
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

const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) return;
    if (!isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado', 'error');
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
        voiceToggleBtn.setAttribute('data-tooltip', 'Detener Voz');
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
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        recognition.onerror = event => {
            mostrarNotificacion(`Error en voz: ${event.error}`, 'error');
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) recognition.start();
            else {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
    } else {
        stopSpeech();
    }
};

const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) return;
    try {
        const response = await fetch('/avatars', { cache: 'no-store' });
        let avatares = [];
        if (response.ok) {
            avatares = await response.json();
        } else {
            avatares = [{ avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }];
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
        console.error('Error al cargar avatares:', error);
        mostrarNotificacion('Error al cargar avatares', 'error');
    }
};

const guardarMensaje = (pregunta, respuesta, video_url = null, tema = null) => {
    console.log('Guardando mensaje:', { pregunta, respuesta, video_url, tema });
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
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
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
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
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    console.log('Historial de chats:', historial);
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        if (!chat.id && chat.id !== 0) {
            console.warn(`Chat en índice ${index} no tiene id válido`, chat);
            return;
        }
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp || Date.now()).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`}</span>
            <div class="chat-actions">
                <button class="rename-btn" data-tooltip="Renombrar" aria-label="Renombrar chat"><i class="fas fa-edit"></i></button>
                <button class="delete-btn" data-tooltip="Eliminar" aria-label="Eliminar chat"><i class="fas fa-trash"></i></button>
            </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp || Date.now()).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`);
        li.tabIndex = 0;
        chatList.appendChild(li);
        li.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON' && !e.target.closest('.chat-actions')) {
                console.log('Cargando chat:', index);
                cargarChat(index);
            }
        });
        li.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                console.log('Cargando chat por tecla:', index);
                cargarChat(index);
            }
        });
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => eliminarChat(index));
    });
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id || currentConversation.id === 0) {
        const selectedLi = getElement(`#chat-list li[data-index="${currentConversation.id}"]`);
        if (selectedLi) selectedLi.classList.add('selected');
    }
    requestAnimationFrame(() => {
        chatList.scrollTop = chatList.scrollHeight;
    });
};

const cargarChat = index => {
    console.log('Cargando chat con índice:', index);
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    const chat = historial[index];
    if (!chat) {
        console.error(`Chat con índice ${index} no encontrado`);
        mostrarNotificacion(`Error: Chat no encontrado`, 'error');
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
        <div class="bot">${typeof marked !== 'undefined' ? marked.parse(msg.respuesta, { breaks: true, gfm: true }) : msg.respuesta}
            <button class="copy-btn" data-text="${msg.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>
        </div>
    `).join('');
    scrollToBottom();
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, nombre: chat.nombre, timestamp: chat.timestamp, mensajes: chat.mensajes }));
    getElements('#chat-list li').forEach(li => li.classList.remove('selected'));
    const selectedLi = getElement(`#chat-list li[data-index="${index}"]`);
    if (selectedLi) selectedLi.classList.add('selected');
    if (window.Prism) {
        console.log('Aplicando Prism.js al cargar chat');
        Prism.highlightAll();
    } else {
        console.error('Prism.js no está cargado');
        mostrarNotificacion('Error: Prism.js no está cargado', 'error');
    }
    addCopyButtonListeners();
};

const renombrarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado`);
        mostrarNotificacion(`Error: Chat no encontrado`, 'error');
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
        mostrarNotificacion('Chat renombrado', 'success');
    }
};

const eliminarChat = index => {
    if (!confirm('¿Eliminar este chat?')) return;
    let historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    historial.splice(index, 1);
    historial.forEach((chat, i) => chat.id = i);
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id === index) {
        localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        mostrarNotificacion('Chat eliminado', 'info');
    }
    actualizarListaChats();
};

const obtenerRecomendacion = async () => {
    try {
        const historial = JSON.parse(localStorage.getItem('currentConversation') || '{}').mensajes || [];
        const response = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial })
        });
        if (!response.ok) throw new Error('Error en /recommend');
        const data = await response.json();
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (!container) return;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.recommendation, { breaks: true, gfm: true }) : data.recommendation) +
            `<button class="copy-btn" data-text="${data.recommendation.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.recommendation);
        guardarMensaje('Recomendación', data.recommendation);
        addCopyButtonListeners();
    } catch (error) {
        console.error('Error en recomendación:', error);
        mostrarNotificacion('Error al obtener recomendación', 'error');
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
            const err = await response.json();
            throw new Error(err.error || `Error en /quiz: ${response.status} ${response.statusText}`);
        }
        const quizData = await response.json();
        // Validar el formato del quiz
        if (!quizData.pregunta || !Array.isArray(quizData.opciones) || !quizData.respuesta_correcta || !quizData.tema || !quizData.nivel) {
            throw new Error('Formato de quiz inválido: faltan campos requeridos');
        }
        if (tipoQuiz === 'opciones' && quizData.opciones.length !== 4) {
            throw new Error('Formato de quiz inválido: se esperaban 4 opciones');
        }
        if (tipoQuiz === 'verdadero_falso' && quizData.opciones.length !== 2) {
            throw new Error('Formato de quiz inválido: se esperaban 2 opciones');
        }
        if (!quizData.opciones.includes(quizData.respuesta_correcta)) {
            throw new Error('Formato de quiz inválido: respuesta_correcta no está en opciones');
        }
        return quizData;
    } catch (error) {
        console.warn('Error en fetch /quiz, generando quiz simulado:', error);
        mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
        return {
            pregunta: tipoQuiz === 'verdadero_falso' ? 'La encapsulación permite ocultar datos.' : '¿Qué es la encapsulación en POO?',
            opciones: tipoQuiz === 'verdadero_falso' ? ['Verdadero', 'Falso'] : ['Ocultar datos', 'Herencia', 'Polimorfismo', 'Abstracción'],
            respuesta_correcta: tipoQuiz === 'verdadero_falso' ? 'Verdadero' : 'Ocultar datos',
            tema: 'POO',
            nivel: 'basico'
        };
    }
};

const sanitizeHTML = (str) => {
    if (!str) return '';
    return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
};

const mostrarQuizEnChat = (quizData) => {
    console.log('mostrarQuizEnChat recibido:', JSON.stringify(quizData, null, 2));
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Contenedor de chat no encontrado');
        mostrarNotificacion('Error: Contenedor de chat no encontrado', 'error');
        return;
    }
    // Validar datos del quiz
    if (!quizData.pregunta || !Array.isArray(quizData.opciones) || !quizData.respuesta_correcta || !quizData.tema || !quizData.nivel) {
        console.error('Datos de quiz incompletos:', quizData);
        mostrarNotificacion('Error: Datos de quiz incompletos', 'error');
        return;
    }
    const botDiv = document.createElement('div');
    botDiv.classList.add('bot');
    // Sanitizar valores para evitar problemas en atributos data-*
    const preguntaSanitizada = sanitizeHTML(quizData.pregunta);
    const temaSanitizado = sanitizeHTML(quizData.tema);
    const respuestaCorrectaSanitizada = sanitizeHTML(quizData.respuesta_correcta);
    const opcionesHtml = quizData.opciones.map((opcion, i) => {
        const opcionSanitizada = sanitizeHTML(opcion);
        return `
            <button class="quiz-option" 
                    data-opcion="${opcionSanitizada}" 
                    data-respuesta-correcta="${respuestaCorrectaSanitizada}" 
                    data-tema="${temaSanitizado}" 
                    data-pregunta="${preguntaSanitizada}">
                ${quizData.tipo_quiz === 'verdadero_falso' ? opcionSanitizada : `${i + 1}. ${opcionSanitizada}`}
            </button>
        `;
    }).join('');
    botDiv.innerHTML = `
        ${typeof marked !== 'undefined' ? marked.parse(preguntaSanitizada) : preguntaSanitizada}
        <div class="quiz-options">${opcionesHtml}</div>
        <button class="copy-btn" data-text="${preguntaSanitizada}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>
    `;
    container.appendChild(botDiv);
    scrollToBottom();
    if (window.Prism) Prism.highlightAllUnder(botDiv);
    guardarMensaje('Quiz', `${preguntaSanitizada}\nOpciones: ${quizData.opciones.join(', ')}`, null, temaSanitizado);
    getElements('.quiz-option').forEach(btn => {
        btn.addEventListener('click', () => {
            getElements('.quiz-option').forEach(opt => opt.classList.remove('selected'));
            btn.classList.add('selected');
            const opcion = btn.dataset.opcion;
            const respuestaCorrecta = btn.dataset.respuesta_correcta;
            const tema = btn.dataset.tema;
            const pregunta = btn.dataset.pregunta;
            console.log('Botón clicado:', { opcion, respuestaCorrecta, tema, pregunta });
            responderQuiz(opcion, respuestaCorrecta, tema, pregunta);
            getElements('.quiz-option').forEach(opt => opt.disabled = true);
        });
    });
    console.log('Botones de quiz generados:', Array.from(getElements('.quiz-option')).map(btn => ({
        opcion: btn.dataset.opcion,
        respuestaCorrecta: btn.dataset.respuesta_correcta,
        tema: btn.dataset.tema,
        pregunta: btn.dataset.pregunta
    })));
    speakText(preguntaSanitizada);
};

const responderQuiz = (opcion, respuestaCorrecta, tema, pregunta) => {
    console.log('Enviando respuesta del quiz:', { opcion, respuestaCorrecta, tema, pregunta });
    opcion = opcion || 'Opción no especificada';
    respuestaCorrecta = respuestaCorrecta || 'Respuesta correcta no especificada';
    tema = tema || 'Tema no especificado';
    pregunta = pregunta || 'Pregunta no especificada';
    if (!opcion || !respuestaCorrecta || !tema) {
        console.error('Faltan datos críticos en responderQuiz:', { opcion, respuestaCorrecta, tema, pregunta });
        mostrarNotificacion(`Error: Faltan datos críticos para responder el quiz. Faltan: ${[
            !opcion && 'opción',
            !respuestaCorrecta && 'respuesta_correcta',
            !tema && 'tema'
        ].filter(Boolean).join(', ')}`, 'error');
        return;
    }
    fetch('/responder_quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            respuesta: opcion,
            respuesta_correcta: respuestaCorrecta,
            tema: tema,
            pregunta: pregunta
        })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /responder_quiz: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        console.log('Respuesta recibida de /responder_quiz:', data);
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (!container || !chatbox) return;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        const icono = data.es_correcta ? '<span class="quiz-feedback correct">✅</span>' : '<span class="quiz-feedback incorrect">❌</span>';
        const respuestaSanitizada = sanitizeHTML(data.respuesta);
        botDiv.innerHTML = icono + (typeof marked !== 'undefined' ? marked.parse(respuestaSanitizada) : respuestaSanitizada) +
            `<button class="copy-btn" data-text="${respuestaSanitizada}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(respuestaSanitizada);
        guardarMensaje(`Respuesta al quiz sobre ${tema}`, respuestaSanitizada);
        addCopyButtonListeners();
    }).catch(error => {
        const errorMsg = `Error al responder quiz: ${error.message.includes('503') ? 'Servicio no disponible. Revisa https://groqstatus.com/' : error.message}`;
        console.error('Error en fetch /responder_quiz:', error);
        mostrarNotificacion(errorMsg, 'error');
    });
};

const sendMessage = () => {
    const input = getElement('#input');
    const nivelExplicacion = localStorage.getItem('nivelExplicacion') || 'basica';
    if (!input) {
        console.error('Elemento #input no encontrado');
        mostrarNotificacion('Error: Campo de entrada no encontrado', 'error');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) {
        mostrarNotificacion('Por favor, escribe una pregunta', 'error');
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        mostrarNotificacion('Error: Contenedor de chat no encontrado', 'error');
        return;
    }
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    input.value = '';
    scrollToBottom();

    guardarMensaje(pregunta, 'Esperando respuesta...');

    const loadingDiv = document.createElement('div');
    loadingDiv.classList.add('bot', 'loading');
    loadingDiv.textContent = '⌛ Generando respuesta...';
    container.appendChild(loadingDiv);
    scrollToBottom();

    const historial = JSON.parse(localStorage.getItem('currentConversation') || '{}').mensajes || [];
    fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pregunta,
            usuario: 'anonimo',
            avatar_id: selectedAvatar,
            nivel_explicacion: nivelExplicacion,
            historial
        })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /ask: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        container.removeChild(loadingDiv);
        const respuestaLimpia = data.respuesta;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(respuestaLimpia) : respuestaLimpia) +
            `<button class="copy-btn" data-text="${respuestaLimpia}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(respuestaLimpia);
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const mensajeIndex = currentConversation.mensajes.findIndex(m => m.pregunta === pregunta && m.respuesta === 'Esperando respuesta...');
        if (mensajeIndex !== -1) {
            currentConversation.mensajes[mensajeIndex].respuesta = respuestaLimpia;
            currentConversation.mensajes[mensajeIndex].video_url = data.video_url;
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
            const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
            historial[currentConversation.id] = currentConversation;
            localStorage.setItem('chatHistory', JSON.stringify(historial));
        }
        addCopyButtonListeners();
    }).catch(error => {
        if (loadingDiv && container.contains(loadingDiv)) {
            container.removeChild(loadingDiv);
        }
        const errorMsg = `Error al obtener respuesta: ${error.message.includes('503') ? 'Servicio de IA no disponible. Revisa https://groqstatus.com/' : error.message}`;
        mostrarNotificacion(errorMsg, 'error');
        console.error('Error en fetch /ask:', error);
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const mensajeIndex = currentConversation.mensajes.findIndex(m => m.pregunta === pregunta && m.respuesta === 'Esperando respuesta...');
        if (mensajeIndex !== -1) {
            currentConversation.mensajes[mensajeIndex].respuesta = 'Error al obtener respuesta';
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
            const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
            historial[currentConversation.id] = currentConversation;
            localStorage.setItem('chatHistory', JSON.stringify(historial));
        }
        actualizarListaChats();
    });
};

const nuevaConversacion = () => {
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
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

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', btn._copyHandler);
        btn._copyHandler = () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado', 'success');
            }).catch(error => {
                mostrarNotificacion('Error al copiar', 'error');
                console.error('Error al copiar:', error);
            });
        };
        btn.addEventListener('click', btn._copyHandler);
    });
};

const toggleDropdown = () => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) {
        dropdownMenu.classList.toggle('active');
    } else {
        console.error('Elemento .dropdown-menu no encontrado');
        mostrarNotificacion('Error: Menú de niveles no encontrado', 'error');
    }
};

const selectNivel = (nivel) => {
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        nivelBtn.textContent = nivel === 'basica' ? 'Explicación Básica' : nivel === 'ejemplos' ? 'Con Ejemplos de Código' : 'Avanzada/Teórica';
        localStorage.setItem('nivelExplicacion', nivel);
        toggleDropdown();
        mostrarNotificacion(`Nivel de explicación: ${nivelBtn.textContent}`, 'success');
    } else {
        console.error('Elemento #nivel-btn no encontrado');
        mostrarNotificacion('Error: Botón de nivel no encontrado', 'error');
    }
};

// Añadir función para verificar si es móvil
const isMobile = () => window.innerWidth < 768;

// Función para cerrar menús al tocar fuera
document.addEventListener('click', (event) => {
    if (isMobile()) {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');
        const dropdownMenu = getElement('.dropdown-menu');

        if (leftSection && leftSection.classList.contains('active') && !leftSection.contains(event.target) && !getElement('.menu-toggle').contains(event.target)) {
            toggleMenu();
        }
        if (rightSection && rightSection.classList.contains('active') && !rightSection.contains(event.target) && !getElement('.menu-toggle-right').contains(event.target)) {
            toggleRightMenu();
        }
        if (dropdownMenu && dropdownMenu.classList.contains('active') && !dropdownMenu.contains(event.target) && !getElement('#nivel-btn').contains(event.target)) {
            toggleDropdown();
        }
    }
});

// Actualizar toggleMenu para cambiar icono en móvil
const toggleMenu = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    if (!leftSection) return;
    leftSection.classList.toggle('active');
    if (isMobile()) {
        const menuToggle = getElement('.menu-toggle');
        if (leftSection.classList.contains('active')) {
            menuToggle.innerHTML = '<i class="fas fa-times"></i>';  // Cambiar a X
        } else {
            menuToggle.innerHTML = '<i class="fas fa-bars"></i>';  // Volver a barras
        }
    }
    if (rightSection && rightSection.classList.contains('active')) {
        rightSection.classList.remove('active');
    }
    const voiceHint = getElement('#voice-hint');
    if (voiceHint && leftSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

// Actualizar toggleRightMenu para cambiar icono en móvil
const toggleRightMenu = () => {
    const rightSection = getElement('.right-section');
    const leftSection = getElement('.left-section');
    if (!rightSection) return;
    rightSection.classList.toggle('active');
    if (isMobile()) {
        const menuToggleRight = getElement('.menu-toggle-right');
        if (rightSection.classList.contains('active')) {
            menuToggleRight.innerHTML = '<i class="fas fa-times"></i>';  // Cambiar a X
        } else {
            menuToggleRight.innerHTML = '<i class="fas fa-bars"></i>';  // Volver a barras
        }
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
    const mensaje = '¡Hola! Soy YELIA, tu asistente para Programación Avanzada en Ingeniería en Telemática. Estoy aquí para ayudarte. ¿Qué quieres aprender hoy?';
    const botDiv = document.createElement('div');
    botDiv.classList.add('bot');
    botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje, { breaks: true, gfm: true }) : mensaje) +
        `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(botDiv);
    scrollToBottom();
    if (window.Prism) Prism.highlightAll();
    guardarMensaje('Bienvenida', mensaje);
    if (vozActiva && userHasInteracted) {
        speakText(mensaje);
    } else if (vozActiva) {
        pendingWelcomeMessage = mensaje;
    }
};

const init = () => {
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
        menuToggle.addEventListener('click', toggleMenu);
        menuToggle.setAttribute('data-tooltip', 'Menú Izquierdo');
        menuToggle.setAttribute('aria-label', 'Abrir menú izquierdo');
    }
    if (menuToggleRight) {
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
        modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-oscuro');
            const isModoOscuro = document.body.classList.contains('modo-oscuro');
            localStorage.setItem('modoOscuro', isModoOscuro);
            modoBtn.setAttribute('data-tooltip', isModoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
            modoBtn.setAttribute('aria-label', isModoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
            modoBtn.innerHTML = `
                <i class="fas ${isModoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
                <span id="modo-text">${isModoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
            `;
            mostrarNotificacion(`Modo ${isModoOscuro ? 'oscuro' : 'claro'} activado`, 'success');
        });
    }
    if (voiceBtn) {
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
        voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
        voiceBtn.innerHTML = `
            <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
        `;
        voiceBtn.addEventListener('click', () => {
            vozActiva = !vozActiva;
            localStorage.setItem('vozActiva', vozActiva);
            voiceBtn.innerHTML = `
                <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
                <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
            `;
            voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
            voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
            mostrarNotificacion(`Audio ${vozActiva ? 'activado' : 'desactivado'}`, 'success');
            if (!vozActiva) stopSpeech();
            if (vozActiva && !userHasInteracted) toggleVoiceHint(true);
        });
    }
    if (quizBtn) {
        quizBtn.setAttribute('data-tooltip', 'Obtener Quiz');
        quizBtn.setAttribute('aria-label', 'Generar un quiz');
        quizBtn.addEventListener('click', () => obtenerQuiz('opciones').then(mostrarQuizEnChat));
    }
    if (recommendBtn) {
        recommendBtn.setAttribute('data-tooltip', 'Obtener Recomendación');
        recommendBtn.setAttribute('aria-label', 'Obtener recomendación de tema');
        recommendBtn.addEventListener('click', () => obtenerRecomendacion().then(data => {
            const mensaje = `Recomendación: ${data.recommendation}`;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
                `<button class="copy-btn" data-text="${mensaje}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            getElement('#chatbox').querySelector('.message-container').appendChild(botDiv);
            scrollToBottom();
            speakText(mensaje);
            guardarMensaje('Recomendación', mensaje);
            addCopyButtonListeners();
        }));
    }
    if (sendBtn) {
        sendBtn.setAttribute('data-tooltip', 'Enviar');
        sendBtn.setAttribute('aria-label', 'Enviar mensaje');
        sendBtn.addEventListener('click', sendMessage);
    }
    if (newChatBtn) {
        newChatBtn.setAttribute('data-tooltip', 'Nuevo Chat');
        newChatBtn.setAttribute('aria-label', 'Iniciar nueva conversación');
        newChatBtn.addEventListener('click', nuevaConversacion);
    }
    if (clearBtn) {
        clearBtn.setAttribute('data-tooltip', 'Limpiar Chat');
        clearBtn.setAttribute('aria-label', 'Limpiar chat actual');
        clearBtn.addEventListener('click', nuevaConversacion); // Cambiado a nuevaConversacion para consistencia
    }
    if (nivelBtn) {
        nivelBtn.setAttribute('data-tooltip', 'Cambiar Nivel');
        nivelBtn.setAttribute('aria-label', 'Cambiar nivel de explicación');
        nivelBtn.addEventListener('click', toggleDropdown);
    }
    if (voiceToggleBtn) {
        voiceToggleBtn.setAttribute('data-tooltip', 'Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }
    const inputElement = getElement('#input');
    if (inputElement) {
        inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }
    // Mostrar mensaje de bienvenida y mensaje de interacción para audio
    setTimeout(() => {
        mostrarMensajeBienvenida();
        if (vozActiva && !userHasInteracted) {
            toggleVoiceHint(true);
        }
    }, 100); // Retraso para asegurar que el DOM esté cargado
    document.addEventListener('click', () => {
        if (!userHasInteracted) {
            userHasInteracted = true;
            toggleVoiceHint(false);
            console.log('Interacción detectada, audio habilitado');
            if (pendingWelcomeMessage) {
                speakText(pendingWelcomeMessage);
                pendingWelcomeMessage = null;
            }
        }
    }, { once: true });
    cargarAvatares();
    actualizarListaChats();
};

document.addEventListener('DOMContentLoaded', init);