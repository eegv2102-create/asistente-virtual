let vozActiva = localStorage.getItem('vozActiva') === 'true';
let isListening = false;
let recognition = null;
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;
let lastVoiceHintTime = 0;
let currentConvId = null;
let quizHistory = [];
let TEMAS_DISPONIBLES = [
    'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
    'Polimorfismo', 'Clases Abstractas e Interfaces', 'UML', 'Diagramas UML',
    'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
    'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
];

// Centralized fetch error handler
const handleFetchError = (error, context) => {
    console.error(`Error in ${context}:`, error);
    let message = 'Unexpected error';
    if (!navigator.onLine) message = 'No internet connection';
    else if (error.message.includes('503')) message = 'Server busy, try again';
    else if (error.message.includes('429')) message = 'Too many requests, please wait';
    else if (error.message.includes('401')) message = 'Unauthorized, check your session';
    else if (error.message) message = error.message;
    mostrarNotificacion(`${context}: ${message}`, 'error');
    return null;
};

// Debounce function for click events
const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

// Optimized scroll to bottom
const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    const lastMessage = container.lastElementChild;
    if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
};

// Get chat history
const getHistorial = () => {
    try {
        const historial = JSON.parse(localStorage.getItem('historial') || '[]');
        return Array.isArray(historial) ? historial : [];
    } catch (error) {
        console.error('Error retrieving history:', error);
        return [];
    }
};

// Show loading indicator
const showLoading = () => {
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return null;
    const loadingDiv = document.createElement('div');
    loadingDiv.classList.add('loading');
    loadingDiv.innerHTML = '<div class="spinner"></div> Loading...';
    container.appendChild(loadingDiv);
    scrollToBottom();
    return loadingDiv;
};

// Hide loading indicator
const hideLoading = (loadingDiv) => {
    if (loadingDiv && loadingDiv.parentNode) loadingDiv.remove();
};

// DOM element selectors
const getElement = (selector) => {
    const element = document.querySelector(selector);
    if (!element) console.warn(`Element ${selector} not found in DOM`);
    return element;
};

const getElements = (selector) => {
    const elements = document.querySelectorAll(selector);
    if (!elements.length) console.warn(`No elements found for ${selector}`);
    return elements;
};

// Show notification
const mostrarNotificacion = (mensaje, tipo) => {
    const notificationCard = getElement('#notification-card');
    if (!notificationCard) return;
    notificationCard.innerHTML = `<p>${mensaje}</p><button onclick="this.parentElement.classList.remove('active')" aria-label="Close notification">Close</button>`;
    notificationCard.classList.remove('info', 'success', 'error');
    notificationCard.classList.add(tipo, 'active');
    setTimeout(() => {
        notificationCard.classList.remove('active');
    }, 5000);
};

// Toggle voice hint
const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) return;
    const now = Date.now();
    if (show && now - lastVoiceHintTime < 5000) return;
    voiceHint.style.display = show ? 'block' : 'none';
    voiceHint.classList.toggle('hidden', !show);
    if (show) lastVoiceHintTime = now;
};

// Speak text with audio or fallback to TTS
const speakText = async (text, audioUrl = null) => {
    if (!vozActiva || !text) {
        mostrarNotificacion('Audio disabled or empty text', 'error');
        return;
    }
    if (!userHasInteracted) {
        toggleVoiceHint(true);
        pendingWelcomeMessage = text;
        return;
    }
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
            currentAudio = new Audio(audioUrl);
            currentAudio.play().catch(error => {
                console.error('Error playing Ready Player Me audio:', error);
                mostrarNotificacion('Error playing audio', 'error');
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
            });
            currentAudio.onended = () => {
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
        } else {
            const reemplazosTTS = {
                'POO': 'Object-Oriented Programming',
                'UML': 'U M L',
                'MVC': 'M V C',
                'ORM': 'Object-Relational Mapping',
                'BD': 'Database',
                'API': 'A P I',
                'SQL': 'S Q L'
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
                .replace(/\b(POO|UML|MVC|ORM|BD|API|SQL)\b/g, match => reemplazosTTS[match] || match)
                .replace(/\bYELIA\b/g, 'Yelia')
                .trim();
            const res = await fetch('/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textoParaVoz })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || `TTS error: ${res.status} ${res.statusText}`);
            }
            const blob = await res.blob();
            currentAudio = new Audio(URL.createObjectURL(blob));
            currentAudio.play().catch(error => {
                console.error('Error playing TTS audio:', error);
                mostrarNotificacion('Error playing audio: ' + error.message, 'error');
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
            });
            currentAudio.onended = () => {
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
        }
    } catch (error) {
        console.error('Audio playback failed, trying speechSynthesis:', error);
        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            const esVoice = voices.find(v => v.lang.includes('es')) || voices[0];
            if (!esVoice) {
                console.warn('No Spanish voice found');
                mostrarNotificacion('No Spanish voice available', 'error');
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
                return;
            }
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'es-ES';
            utterance.voice = esVoice;
            utterance.pitch = 1;
            utterance.rate = 0.9;
            utterance.onend = () => {
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
            utterance.onerror = (event) => {
                console.error('speechSynthesis error:', event.error);
                let errorMsg = 'Local audio error: ' + event.error;
                if (event.error === 'not-allowed') errorMsg = 'Audio not allowed, interact with page first';
                if (event.error === 'network') errorMsg = 'Network error in speech synthesis';
                mostrarNotificacion(errorMsg, 'error');
                const botMessage = getElement('.bot:last-child');
                if (botMessage) botMessage.classList.remove('speaking');
            };
            speechSynthesis.speak(utterance);
            currentAudio = utterance;
        } else {
            console.warn('speechSynthesis not supported');
            mostrarNotificacion('Audio not supported in this browser', 'error');
            const botMessage = getElement('.bot:last-child');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

// Stop speech and recognition
const stopSpeech = () => {
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
            voiceToggleBtn.setAttribute('data-tooltip', 'Start Voice');
            voiceToggleBtn.setAttribute('aria-label', 'Start voice recognition');
        }
        mostrarNotificacion('Voice recognition stopped', 'info');
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

// Voice recognition
const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) return;
    if (!isListening) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            mostrarNotificacion('Voice recognition not supported in this browser', 'error');
            return;
        }
        recognition = new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.continuous = true;
        let timeoutId = null;
        recognition.start();
        isListening = true;
        voiceToggleBtn.classList.add('voice-active');
        voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
        voiceToggleBtn.setAttribute('data-tooltip', 'Stop Voice');
        voiceToggleBtn.setAttribute('aria-label', 'Stop voice recognition');
        voiceToggleBtn.classList.add('pulse');
        mostrarNotificacion('Voice recognition started', 'success');
        const resetTimeout = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (isListening) stopSpeech();
                mostrarNotificacion('Voice recognition stopped due to inactivity', 'info');
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
                voiceToggleBtn.setAttribute('data-tooltip', 'Start Voice');
                voiceToggleBtn.setAttribute('aria-label', 'Start voice recognition');
            }
        };
        recognition.onerror = event => {
            clearTimeout(timeoutId);
            let errorMsg = `Voice recognition error: ${event.error}`;
            if (event.error === 'no-speech') errorMsg = 'No speech detected, try again';
            if (event.error === 'aborted') errorMsg = 'Voice recognition canceled';
            if (event.error === 'network') errorMsg = 'Network error in voice recognition';
            mostrarNotificacion(errorMsg, 'error');
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active', 'pulse');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Start Voice');
            voiceToggleBtn.setAttribute('aria-label', 'Start voice recognition');
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
                resetTimeout();
            } else {
                clearTimeout(timeoutId);
                voiceToggleBtn.classList.remove('voice-active', 'pulse');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Start Voice');
                voiceToggleBtn.setAttribute('aria-label', 'Start voice recognition');
            }
        };
    } else {
        stopSpeech();
    }
};

// Load conversations
const cargarConversaciones = async () => {
    try {
        const res = await fetch('/conversations');
        if (!res.ok) throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const chatList = getElement('#chat-list');
        if (!chatList) return;
        chatList.innerHTML = '';

        data.conversations.forEach(conv => {
            const li = document.createElement('li');
            li.dataset.id = conv.id;
            li.innerHTML = `
                <span class="chat-name">${conv.nombre}</span>
                <div class="chat-actions">
                    <button class="rename-btn" data-tooltip="Rename"><i class="fas fa-edit"></i></button>
                    <button class="delete-btn" data-tooltip="Delete"><i class="fas fa-trash"></i></button>
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
        handleFetchError(error, 'Load conversations');
    }
};

// Load messages for a conversation
const cargarMensajes = async (convId) => {
    try {
        const res = await fetch(`/messages/${convId}`);
        if (!res.ok) {
            if (res.status === 404) {
                console.warn(`Conversation ${convId} not found, creating new.`);
                const newConv = await nuevaConversacion();
                if (newConv && newConv.id) {
                    currentConvId = newConv.id;
                    const newRes = await fetch(`/messages/${currentConvId}`);
                    if (!newRes.ok) throw new Error(`HTTP error ${newRes.status}: ${await newRes.text()}`);
                    const newData = await newRes.json();
                    return cargarMensajes(newData.conv_id); // Recursive call for new conversation
                }
                throw new Error('Failed to create new conversation');
            }
            throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        currentConvId = data.conv_id || convId;

        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) return;
        container.innerHTML = '';

        data.messages.forEach(msg => {
            const div = document.createElement('div');
            div.classList.add(msg.role === 'user' ? 'user' : 'bot');
            div.innerHTML = (typeof marked !== 'undefined' ? marked.parse(msg.content) : msg.content) +
                `<button class="copy-btn" data-text="${msg.content.replace(/"/g, '&quot;')}" aria-label="Copy message"><i class="fas fa-copy"></i></button>`;
            container.appendChild(div);
        });

        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        addCopyButtonListeners();
    } catch (error) {
        handleFetchError(error, 'Load messages');
    }
};

// Delete conversation
const eliminarConversacion = async (convId) => {
    if (!confirm("Are you sure you want to delete this conversation?")) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            if (currentConvId === convId) {
                currentConvId = null;
                const container = getElement('#chatbox')?.querySelector('.message-container');
                if (container) container.innerHTML = '';
                mostrarMensajeBienvenida();
            }
            cargarConversaciones();
            mostrarNotificacion('Conversation deleted', 'success');
        } else {
            throw new Error((await res.json()).error || 'Error deleting conversation');
        }
    } catch (error) {
        handleFetchError(error, 'Delete conversation');
    }
};

// Rename conversation
const renombrarConversacion = async (convId) => {
    const nuevoNombre = prompt('New name for the conversation:');
    if (!nuevoNombre) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nuevoNombre })
        });
        if (res.ok) {
            cargarConversaciones();
            mostrarNotificacion('Conversation renamed', 'success');
        } else {
            throw new Error((await res.json()).error || 'Error renaming conversation');
        }
    } catch (error) {
        handleFetchError(error, 'Rename conversation');
    }
};

// Send message
const sendMessage = async () => {
    const input = getElement('#input');
    const nivelBtn = getElement('#nivel-btn');
    if (!input || !nivelBtn) {
        mostrarNotificacion('Error: Input or level button not found', 'error');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) return;
    input.value = '';

    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return;
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(pregunta) : pregunta) +
        `<button class="copy-btn" data-text="${pregunta.replace(/"/g, '&quot;')}" aria-label="Copy message"><i class="fas fa-copy"></i></button>`;
    container.appendChild(userDiv);
    const loadingDiv = showLoading();
    scrollToBottom();

    if (!currentConvId) {
        try {
            const res = await fetch('/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: 'New Chat' })
            });
            if (!res.ok) throw new Error(`Error creating conversation: ${res.status}`);
            const data = await res.json();
            currentConvId = data.id;
            await cargarConversaciones();
        } catch (error) {
            handleFetchError(error, 'Create conversation');
            hideLoading(loadingDiv);
            return;
        }
    }

    try {
        await fetch(`/messages/${currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', content: pregunta })
        });

        const nivel = nivelBtn.textContent.trim().toLowerCase();
        const nivelExplicacion = nivel.includes('básica') ? 'basica' :
                                 nivel.includes('ejemplos') ? 'ejemplos' : 'avanzada';
        const res = await fetch('/buscar_respuesta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pregunta,
                historial: getHistorial(),
                nivel_explicacion: nivelExplicacion,
                conv_id: currentConvId
            })
        });
        if (!res.ok) throw new Error(`Error processing request: ${res.status}`);
        const data = await res.json();
        currentConvId = data.conv_id || currentConvId;

        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copy message"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        addCopyButtonListeners();

        try {
            const animationRes = await fetch('/proxy_rpm_animation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: data.respuesta, voiceId: 'es-MX-JorgeNeural' })
            });
            if (!animationRes.ok) throw new Error('Error fetching Ready Player Me animation');
            const animationData = await animationRes.json();
            const { audioUrl, visemes } = animationData;
            botDiv.classList.add('speaking');
            speakText(data.respuesta, audioUrl);

            if (avatarModel && visemes) {
                let visemeIndex = 0;
                const visemeInterval = setInterval(() => {
                    if (visemeIndex >= visemes.length) {
                        clearInterval(visemeInterval);
                        botDiv.classList.remove('speaking');
                        return;
                    }
                    const viseme = visemes[visemeIndex];
                    // Apply viseme logic here (requires Ready Player Me SDK)
                    visemeIndex++;
                }, 100);
            }
        } catch (error) {
            console.error('Ready Player Me API error:', error);
            mostrarNotificacion('Error fetching avatar animation, using TTS', 'error');
            botDiv.classList.add('speaking');
            speakText(data.respuesta);
        }

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
        handleFetchError(error, 'Send message');
    } finally {
        hideLoading(loadingDiv);
    }
};

// Create new conversation
const nuevaConversacion = async () => {
    try {
        const res = await fetch('/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: 'New Chat' })
        });
        if (!res.ok) throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        currentConvId = data.id;
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
        return data;
    } catch (error) {
        handleFetchError(error, 'Create new conversation');
        return null;
    }
};

// Copy button handler
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
        mostrarNotificacion('Text copied to clipboard', 'success');
        btn.innerHTML = `<i class="fas fa-check"></i>`;
        setTimeout(() => btn.innerHTML = `<i class="fas fa-copy"></i>`, 2000);
    }).catch(err => {
        console.error('Error copying text:', err);
        mostrarNotificacion('Error copying text', 'error');
    });
};

// Toggle dropdown menu
const toggleDropdown = (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) {
        dropdownMenu.classList.toggle('active');
        if (event) event.stopPropagation();
    } else {
        mostrarNotificacion('Error: Level menu not found', 'error');
    }
};

// Set explanation level
const setNivelExplicacion = (nivel) => {
    if (!['basica', 'ejemplos', 'avanzada'].includes(nivel)) {
        mostrarNotificacion('Error: Invalid level', 'error');
        return;
    }
    localStorage.setItem('nivelExplicacion', nivel);
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        const nivelText = nivel === 'basica' ? 'Basic Explanation' :
                          nivel === 'ejemplos' ? 'With Code Examples' : 'Advanced/Theoretical';
        nivelBtn.innerHTML = `${nivelText} <i class="fas fa-caret-down"></i>`;
        const dropdownMenu = getElement('.dropdown-menu');
        if (dropdownMenu?.classList.contains('active')) {
            dropdownMenu.classList.remove('active');
        }
        mostrarNotificacion(`Level changed to: ${nivelText}`, 'success');
    } else {
        mostrarNotificacion('Error: Level button not found', 'error');
    }
};

// Check if mobile
const isMobile = () => window.innerWidth < 768;

// Handle global clicks
document.addEventListener('click', (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    const nivelBtn = getElement('#nivel-btn');

    if (nivelBtn?.contains(event.target)) return;
    if (dropdownMenu?.contains(event.target)) return;
    if (dropdownMenu?.classList.contains('active')) {
        dropdownMenu.classList.remove('active');
    }

    if (isMobile()) {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');

        if (leftSection?.classList.contains('active') &&
            !leftSection.contains(event.target) &&
            !getElement('.menu-toggle')?.contains(event.target)) {
            toggleMenu();
        }

        if (rightSection?.classList.contains('active') &&
            !rightSection.contains(event.target) &&
            !getElement('.menu-toggle-right')?.contains(event.target)) {
            toggleRightMenu();
        }
    }
});

// Toggle left menu
const toggleMenu = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    if (!leftSection) return;
    leftSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggle = getElement('.menu-toggle');
        if (menuToggle) {
            menuToggle.innerHTML = leftSection.classList.contains('active')
                ? '<i class="fas fa-times"></i>'
                : '<i class="fas fa-bars"></i>';
        }
    }

    if (rightSection?.classList.contains('active')) {
        rightSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && leftSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

// Toggle right menu
const toggleRightMenu = () => {
    const rightSection = getElement('.right-section');
    const leftSection = getElement('.left-section');
    if (!rightSection) return;
    rightSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggleRight = getElement('.menu-toggle-right');
        if (menuToggleRight) {
            menuToggleRight.innerHTML = rightSection.classList.contains('active')
                ? '<i class="fas fa-times"></i>'
                : '<i class="fas fa-bars"></i>';
        }
    }

    if (leftSection?.classList.contains('active')) {
        leftSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && rightSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

// Show welcome message
const mostrarMensajeBienvenida = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Chat container not found', 'error');
        return;
    }

    const mensaje = '👋 Hello! I am YELIA, your Advanced Programming in Telematics Engineering assistant. What would you like to learn today?';
    
    if (container.children.length === 0) {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje, { breaks: true, gfm: true }) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copy message"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        addCopyButtonListeners();

        if (vozActiva && userHasInteracted) {
            speakText(mensaje);
        } else if (vozActiva) {
            pendingWelcomeMessage = mensaje;
        }
    }
};

// Get quiz
const obtenerQuiz = async (tipo) => {
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonymous', nivel: localStorage.getItem('nivelExplicacion') || 'basica' })
        });
        if (!res.ok) throw new Error(`Error fetching quiz: ${res.status}`);
        const data = await res.json();
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Fetch quiz');
        hideLoading(loadingDiv);
        return null;
    }
};

// Display quiz in chat
const mostrarQuizEnChat = async (quizData) => {
    if (!quizData) return;
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return;
    const quizDiv = document.createElement('div');
    quizDiv.classList.add('bot');
    quizDiv.setAttribute('aria-live', 'polite');
    let optionsHtml = quizData.opciones.map((opcion, index) => `
        <div class="quiz-option" data-option="${opcion}" data-index="${index}" tabindex="0" role="button" aria-label="Option ${opcion}">${opcion}</div>
    `).join('');
    quizDiv.innerHTML = `
        <p>${quizData.pregunta}</p>
        <div class="quiz-options">${optionsHtml}</div>
        <button class="copy-btn" data-text="${quizData.pregunta}" aria-label="Copy question"><i class="fas fa-copy"></i></button>
    `;
    quizDiv.dataset.respuestaCorrecta = quizData.respuesta_correcta;
    quizDiv.dataset.tema = quizData.tema || 'unknown';
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

// Handle quiz option selection
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
        mostrarNotificacion('Error: Could not determine correct answer', 'error');
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
        if (!res.ok) throw new Error(`Error responding to quiz: ${res.status}`);
        const data = await res.json();
        const isCorrect = data.es_correcta;
        option.classList.add(isCorrect ? 'correct' : 'incorrect');
        if (!isCorrect) {
            const correctOption = quizContainer.querySelector(`.quiz-option[data-option="${data.respuesta_correcta}"]`);
            if (correctOption) correctOption.classList.add('correct');
        }
        hideLoading(loadingDiv);
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) return;
        const feedbackDiv = document.createElement('div');
        feedbackDiv.classList.add('bot');
        feedbackDiv.dataset.tema = quizData.tema;
        feedbackDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copy response"><i class="fas fa-copy"></i></button>`;
        container.appendChild(feedbackDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.respuesta);
        addCopyButtonListeners();

        quizHistory.push({ pregunta: quizData.pregunta, respuesta: data.respuesta, tema: quizData.tema });
        if (quizHistory.length > 10) quizHistory.shift();
        localStorage.setItem('quizHistory', JSON.stringify(quizHistory));
    } catch (error) {
        handleFetchError(error, 'Respond quiz');
        hideLoading(loadingDiv);
    }
};

// Load topics
const cargarTemas = async () => {
    const cacheKey = 'temasCache';
    const cacheTimeKey = 'temasCacheTime';
    const cacheDuration = 24 * 60 * 60 * 1000;
    const cachedTemas = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);

    if (cachedTemas && cachedTime && Date.now() - parseInt(cachedTime) < cacheDuration) {
        TEMAS_DISPONIBLES = JSON.parse(cachedTemas);
        return;
    }

    try {
        const res = await fetch('/temas', { method: 'GET' });
        if (!res.ok) throw new Error(`Error loading topics: ${res.status}`);
        const data = await res.json();
        if (data.temas && Array.isArray(data.temas)) {
            TEMAS_DISPONIBLES = data.temas;
            localStorage.setItem(cacheKey, JSON.stringify(TEMAS_DISPONIBLES));
            localStorage.setItem(cacheTimeKey, Date.now().toString());
        }
    } catch (error) {
        handleFetchError(error, 'Load topics');
    }
};

// Setup 3D avatar scene
// let scene, camera, renderer, avatarModel; /* Comentado: variables para avatar */

// const setupAvatarScene = async () => { /* Comentado: función completa para avatar */
//     try {
//         const container = getElement('#avatar-container');
//         if (!container) {
//             mostrarNotificacion('Error: Avatar container not found', 'error');
//             return;
//         }
//         if (typeof THREE === 'undefined') {
//             mostrarNotificacion('Error: Three.js not loaded', 'error');
//             container.classList.add('error');
//             return;
//         }

//         const keyRes = await fetch('/get_rpm_api_key');
//         if (!keyRes.ok) throw new Error(`Error fetching API key: ${keyRes.statusText}`);
//         const keyData = await keyRes.json();
//         const apiKey = keyData.rpm_api_key;

//         scene = new THREE.Scene();
//         camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
//         renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//         renderer.setSize(container.clientWidth, container.clientHeight);
//         container.appendChild(renderer.domElement);

//         const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
//         scene.add(ambientLight);
//         const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
//         directionalLight.position.set(0, 1, 1);
//         scene.add(directionalLight);

//         const avatarUrl = `https://models.readyplayer.me/68ae2fecfa03635f0fbcbae8.glb?apiKey=${apiKey}`;
//         const loader = new THREE.GLTFLoader();
//         loader.load(
//             avatarUrl,
//             (gltf) => {
//                 avatarModel = gltf.scene;
//                 avatarModel.scale.set(1.5, 1.5, 1.5);
//                 avatarModel.position.set(0, -1, 0);
//                 scene.add(avatarModel);
//                 container.classList.remove('error', 'loading');
//                 animate();
//             },
//             (xhr) => {
//                 const percentComplete = (xhr.loaded / xhr.total) * 100;
//                 container.classList.add('loading');
//             },
//             (error) => {
//                 console.error('Error loading GLB model:', error);
//                 mostrarNotificacion('Error loading 3D avatar', 'error');
//                 container.classList.add('error');
//             }
//         );

//         camera.position.z = 2;

//         window.addEventListener('resize', () => {
//             const width = container.clientWidth;
//             const height = container.clientHeight;
//             renderer.setSize(width, height);
//             camera.aspect = width / height;
//             camera.updateProjectionMatrix();
//         });

//         function animate() {
//             requestAnimationFrame(animate);
//             renderer.render(scene, camera);
//         }
//     } catch (error) {
//         console.error('Error in setupAvatarScene:', error);
//         mostrarNotificacion('Error initializing 3D avatar', 'error');
//         const container = getElement('#avatar-container');
//         if (container) container.classList.add('error');
//     }
// };

// Initialize application
const init = () => {
    quizHistory = JSON.parse(localStorage.getItem('quizHistory') || '[]');

    const waitForThree = () => {
        return new Promise((resolve, reject) => {
            const checkThree = setInterval(() => {
                if (typeof THREE !== 'undefined' && typeof THREE.GLTFLoader !== 'undefined') {
                    clearInterval(checkThree);
                    resolve();
                }
            }, 100);
            setTimeout(() => {
                clearInterval(checkThree);
                reject(new Error('Three.js not loaded in time'));
            }, 10000);
        });
    };

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
    const inputElement = getElement('#input');

    if (menuToggle) {
        menuToggle.removeEventListener('click', toggleMenu);
        menuToggle.addEventListener('click', toggleMenu);
        menuToggle.setAttribute('data-tooltip', 'Left Menu');
        menuToggle.setAttribute('aria-label', 'Open left menu');
    }
    if (menuToggleRight) {
        menuToggleRight.removeEventListener('click', toggleRightMenu);
        menuToggleRight.addEventListener('click', toggleRightMenu);
        menuToggleRight.setAttribute('data-tooltip', 'Right Menu');
        menuToggleRight.setAttribute('aria-label', 'Open right menu');
    }
    if (modoBtn) {
        const modoOscuro = localStorage.getItem('modoOscuro') === 'true';
        modoBtn.setAttribute('data-tooltip', modoOscuro ? 'Switch to Light Mode' : 'Switch to Dark Mode');
        modoBtn.setAttribute('aria-label', modoOscuro ? 'Switch to light mode' : 'Switch to dark mode');
        modoBtn.innerHTML = `
            <i class="fas ${modoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${modoOscuro ? 'Light Mode' : 'Dark Mode'}</span>
        `;
        modoBtn.removeEventListener('click', handleModoToggle);
        modoBtn.addEventListener('click', debounce(handleModoToggle, 300));
    }
    if (voiceBtn) {
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Disable Audio' : 'Enable Audio');
        voiceBtn.setAttribute('aria-label', vozActiva ? 'Disable audio' : 'Enable audio');
        voiceBtn.innerHTML = `
            <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${vozActiva ? 'Disable Audio' : 'Enable Audio'}</span>
        `;
        voiceBtn.removeEventListener('click', handleVoiceToggle);
        voiceBtn.addEventListener('click', handleVoiceToggle);
    }
    if (quizBtn) {
        quizBtn.setAttribute('data-tooltip', 'Start Quiz');
        quizBtn.setAttribute('aria-label', 'Generate a quiz');
        quizBtn.removeEventListener('click', handleQuizClick);
        quizBtn.addEventListener('click', debounce(handleQuizClick, 300));
    }
    if (recommendBtn) {
        recommendBtn.setAttribute('data-tooltip', 'Recommend Topic');
        recommendBtn.setAttribute('aria-label', 'Get topic recommendation');
        recommendBtn.removeEventListener('click', handleRecommendClick);
        recommendBtn.addEventListener('click', debounce(handleRecommendClick, 300));
    }
    if (sendBtn) {
        sendBtn.setAttribute('data-tooltip', 'Send');
        sendBtn.setAttribute('aria-label', 'Send message');
        sendBtn.removeEventListener('click', sendMessage);
        sendBtn.addEventListener('click', debounce(sendMessage, 300));
    }
    if (newChatBtn) {
        newChatBtn.setAttribute('data-tooltip', 'New Chat');
        newChatBtn.setAttribute('aria-label', 'Start new conversation');
        newChatBtn.removeEventListener('click', nuevaConversacion);
        newChatBtn.addEventListener('click', debounce(nuevaConversacion, 300));
    }
    if (clearBtn) {
        clearBtn.setAttribute('data-tooltip', 'Clear Chat');
        clearBtn.setAttribute('aria-label', 'Clear current chat');
        clearBtn.removeEventListener('click', nuevaConversacion);
        clearBtn.addEventListener('click', debounce(nuevaConversacion, 300));
    }
    if (nivelBtn) {
        nivelBtn.setAttribute('data-tooltip', 'Change Level');
        nivelBtn.setAttribute('aria-label', 'Change explanation level');
        nivelBtn.removeEventListener('click', toggleDropdown);
        nivelBtn.addEventListener('click', toggleDropdown);
    }
    if (voiceToggleBtn) {
        voiceToggleBtn.setAttribute('data-tooltip', 'Voice');
        voiceToggleBtn.setAttribute('aria-label', 'Start voice recognition');
        voiceToggleBtn.removeEventListener('click', toggleVoiceRecognition);
        voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }
    if (inputElement) {
        inputElement.removeEventListener('keydown', handleInputKeydown);
        inputElement.addEventListener('keydown', handleInputKeydown);
    }

    // waitForThree() /* Comentado: carga de Three.js para avatar */
    //     .then(() => {
    //         setupAvatarScene();
    //     })
    //     .catch((error) => {
    //         console.error('Error loading Three.js:', error);
    //         mostrarNotificacion('Error initializing 3D avatar: Three.js not available', 'error');
    //     });

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
    setNivelExplicacion(nivelGuardado);
};

// Toggle dark mode
const handleModoToggle = () => {
    document.body.classList.toggle('modo-oscuro');
    const isModoOscuro = document.body.classList.contains('modo-oscuro');
    localStorage.setItem('modoOscuro', isModoOscuro);
    const modoBtn = getElement('#modo-btn');
    if (modoBtn) {
        modoBtn.setAttribute('data-tooltip', isModoOscuro ? 'Switch to Light Mode' : 'Switch to Dark Mode');
        modoBtn.setAttribute('aria-label', isModoOscuro ? 'Switch to light mode' : 'Switch to dark mode');
        modoBtn.innerHTML = `
            <i class="fas ${isModoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${isModoOscuro ? 'Light Mode' : 'Dark Mode'}</span>
        `;
        mostrarNotificacion(`Mode ${isModoOscuro ? 'dark' : 'light'} activated`, 'success');
    }
};

// Toggle voice
const handleVoiceToggle = () => {
    vozActiva = !vozActiva;
    localStorage.setItem('vozActiva', vozActiva);
    const voiceBtn = getElement('#voice-btn');
    if (voiceBtn) {
        voiceBtn.innerHTML = `
            <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${vozActiva ? 'Disable Audio' : 'Enable Audio'}</span>
        `;
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Disable Audio' : 'Enable Audio');
        voiceBtn.setAttribute('aria-label', vozActiva ? 'Disable audio' : 'Enable audio');
        mostrarNotificacion(`Audio ${vozActiva ? 'enabled' : 'disabled'}`, 'success');
    }
    if (!vozActiva) stopSpeech();
    if (vozActiva && !userHasInteracted) toggleVoiceHint(true);
};

// Handle quiz button click
const handleQuizClick = () => {
    obtenerQuiz('opciones').then(mostrarQuizEnChat);
};

// Handle recommendation button click
const handleRecommendClick = async () => {
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonymous', historial: getHistorial() })
        });
        if (!res.ok) throw new Error(`Error fetching recommendation: ${res.status}`);
        const data = await res.json();
        currentConvId = data.conv_id || currentConvId;
        const mensaje = data.recommendation;
        if (!mensaje) throw new Error('No valid recommendation received');
        const tema = mensaje.match(/Te recomiendo estudiar: (.*)/)?.[1] || '';
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.dataset.tema = tema;
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje}" aria-label="Copy message"><i class="fas fa-copy"></i></button>`;
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) {
            mostrarNotificacion('Error: Chat container not found', 'error');
            return;
        }
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(mensaje);
        addCopyButtonListeners();

        if (currentConvId) {
            await fetch(`/messages/${currentConvId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'bot', content: mensaje, tema })
            });
            await cargarConversaciones();
        }

        const historial = getHistorial();
        historial.push({ pregunta: '', respuesta: mensaje, tema });
        if (historial.length > 10) historial.shift();
        localStorage.setItem('historial', JSON.stringify(historial));
    } catch (error) {
        handleFetchError(error, 'Fetch recommendation');
    } finally {
        hideLoading(loadingDiv);
    }
};

// Handle input keydown
const handleInputKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
};

// Handle first user interaction
const handleFirstInteraction = () => {
    if (!userHasInteracted) {
        userHasInteracted = true;
        toggleVoiceHint(false);
        if (pendingWelcomeMessage) {
            speakText(pendingWelcomeMessage);
            pendingWelcomeMessage = null;
        }
    }
};

// Initialize on DOM content loaded
document.addEventListener('DOMContentLoaded', init);