let vozActiva = true, isListening = false, recognition = null, voicesLoaded = false;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
const { jsPDF } = window.jspdf;

const getElement = selector => document.querySelector(selector);
const getElements = selector => document.querySelectorAll(selector);

const mostrarNotificacion = (mensaje, tipo = 'info') => {
    const card = getElement('#notification-card');
    if (!card) {
        console.error('Elemento #notification-card no encontrado');
        return;
    }
    card.innerHTML = `
        <p>${mensaje}</p>
        <button aria-label="Cerrar notificación" onclick="this.parentElement.classList.remove('active')">Cerrar</button>
    `;
    card.classList.add('active', tipo);
    card.style.animation = 'fadeIn 0.5s ease-out';
    setTimeout(() => {
        card.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => card.classList.remove('active', tipo), 500);
    }, 5000);
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
        if (window.innerWidth <= 768) {
            chatbox.scrollTop = chatbox.scrollHeight;
        }
    });
};

const speakText = text => {
    if (!vozActiva || !text) return;
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(res => {
        if (!res.ok) throw new Error('Error en TTS');
        return res.blob();
    }).then(blob => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaElementSource(currentAudio);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const canvas = getElement('#lip-sync-canvas');
        const ctx = canvas?.getContext('2d');
        function draw() {
            if (currentAudio && !currentAudio.paused && !currentAudio.ended && ctx) {
                analyser.getByteFrequencyData(dataArray);
                let amplitude = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(25, 25, amplitude / 10, 0, 2 * Math.PI);
                ctx.fillStyle = 'var(--accent)';
                ctx.fill();
                requestAnimationFrame(draw);
            } else if (botMessage) {
                botMessage.classList.remove('speaking');
                if (canvas) canvas.style.opacity = '0';
            }
        }
        if (canvas) {
            canvas.style.opacity = '1';
            draw();
        }
        currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
            if (canvas) canvas.style.opacity = '0';
            updateSpeechButton();
        };
    }).catch(error => {
        console.error('TTS /tts falló, usando speechSynthesis fallback', error);
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        utterance.onend = () => {
            if (botMessage) botMessage.classList.remove('speaking');
            updateSpeechButton();
        };
        speechSynthesis.speak(utterance);
        currentAudio = utterance;
    });
};

const pauseSpeech = () => {
    const speechBtn = getElement('#speech-btn');
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        mostrarNotificacion('Voz pausada', 'success');
        speechBtn.innerHTML = `<i class="fas fa-play"></i>`;
        speechBtn.setAttribute('data-tooltip', 'Reanudar voz');
        speechBtn.onclick = resumeSpeech;
    } else if ('speechSynthesis' in window && currentAudio) {
        speechSynthesis.pause();
        mostrarNotificacion('Voz pausada', 'success');
        speechBtn.innerHTML = `<i class="fas fa-play"></i>`;
        speechBtn.setAttribute('data-tooltip', 'Reanudar voz');
        speechBtn.onclick = resumeSpeech;
    }
};

const resumeSpeech = () => {
    const speechBtn = getElement('#speech-btn');
    if (currentAudio instanceof Audio) {
        currentAudio.play();
        mostrarNotificacion('Voz reanudada', 'success');
        speechBtn.innerHTML = `<i class="fas fa-pause"></i>`;
        speechBtn.setAttribute('data-tooltip', 'Pausar voz');
        speechBtn.onclick = pauseSpeech;
    } else if ('speechSynthesis' in window && currentAudio && speechSynthesis.paused) {
        speechSynthesis.resume();
        mostrarNotificacion('Voz reanudada', 'success');
        speechBtn.innerHTML = `<i class="fas fa-pause"></i>`;
        speechBtn.setAttribute('data-tooltip', 'Pausar voz');
        speechBtn.onclick = pauseSpeech;
    }
};

const updateSpeechButton = () => {
    const speechBtn = getElement('#speech-btn');
    if (speechBtn) {
        speechBtn.innerHTML = `<i class="fas fa-pause"></i>`;
        speechBtn.setAttribute('data-tooltip', 'Pausar voz');
        speechBtn.onclick = pauseSpeech;
    }
};

const toggleVoz = () => {
    vozActiva = !vozActiva;
    const muteBtn = getElement('#mute-btn');
    if (muteBtn) {
        muteBtn.innerHTML = `<i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>`;
        muteBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar voz' : 'Activar voz');
    }
    if (!vozActiva) {
        if (currentAudio instanceof Audio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        } else if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
    }
    mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
};

const startVoiceRecognition = () => {
    const voiceBtn = getElement('#voice-btn');
    const input = getElement('#input');
    if (!input || !voiceBtn) {
        mostrarNotificacion('Error: Elementos de voz no encontrados', 'error');
        return;
    }
    if (!('webkitSpeechRecognition' in window)) {
        mostrarNotificacion('Reconocimiento de voz no soportado en este navegador.', 'error');
        return;
    }
    recognition = new webkitSpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = event => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
        }
        input.value = transcript;
        if (event.results[event.results.length - 1]?.isFinal) {
            sendMessage();
            stopVoiceRecognition();
        }
    };
    recognition.onerror = event => {
        mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
        stopVoiceRecognition();
    };
    recognition.onend = () => {
        isListening = false;
        voiceBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
        voiceBtn.setAttribute('data-tooltip', 'Iniciar voz');
        voiceBtn.onclick = startVoiceRecognition;
    };
    recognition.start();
    isListening = true;
    voiceBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
    voiceBtn.setAttribute('data-tooltip', 'Detener voz');
    voiceBtn.onclick = stopVoiceRecognition;
    mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
};

const stopVoiceRecognition = () => {
    if (isListening && recognition) {
        recognition.stop();
        isListening = false;
        const voiceBtn = getElement('#voice-btn');
        if (voiceBtn) {
            voiceBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceBtn.setAttribute('data-tooltip', 'Iniciar voz');
            voiceBtn.onclick = startVoiceRecognition;
        }
        mostrarNotificacion('Reconocimiento de voz detenido', 'success');
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
                { avatar_id: 'default', nombre: 'Default', url: '/static/img/avatar-default.png' },
                { avatar_id: 'poo', nombre: 'POO', url: '/static/img/poo.png' }
            ];
            console.warn('Usando avatares estáticos por fallo en /avatars');
        }
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
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
    } catch (error) {
        mostrarNotificacion(`Error al cargar avatares: ${error.message}`, 'error');
        console.error('Error al cargar avatares:', error);
        const fallbackAvatares = [
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/avatar-default.png' },
            { avatar_id: 'poo', nombre: 'POO', url: '/static/img/poo.png' }
        ];
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
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
    }
};

const guardarMensaje = (pregunta, respuesta, video_url = null) => {
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
        currentConversation = { id: historial.length, nombre: `Chat ${new Date().toLocaleString()}`, timestamp: Date.now(), mensajes: [] };
        historial.push({ nombre: currentConversation.nombre, timestamp: currentConversation.timestamp, mensajes: [] });
        localStorage.setItem('chatHistory', JSON.stringify(historial));
    }
    currentConversation.mensajes.push({ pregunta, respuesta, video_url });
    localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    historial[currentConversation.id].mensajes = currentConversation.mensajes;
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
};

const actualizarListaChats = () => {
    const chatList = getElement('#chat-list');
    if (!chatList) {
        console.error('Elemento #chat-list no encontrado');
        return;
    }
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (chatList.children.length === historial.length && !historial.some((chat, i) => chatList.children[i]?.dataset.index != i)) return;
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`}</span>
                        <div class="chat-actions">
                            <button class="rename-btn" aria-label="Renombrar"><i class="fas fa-edit"></i></button>
                            <button class="delete-btn" aria-label="Eliminar"><i class="fas fa-trash"></i></button>
                        </div>`;
        li.dataset.index = index;
        li.dataset.tooltip = chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`);
        chatList.appendChild(li);
        li.addEventListener('click', e => e.target.tagName !== 'BUTTON' && cargarChat(index));
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => eliminarChat(index));
    });
    chatList.scrollTop = chatList.scrollHeight;
};

const cargarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const chat = historial[index];
    if (!chat) return;
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = chat.mensajes.map(msg => `<div class="user">${msg.pregunta}</div><div class="bot">${msg.video_url ? `<img src="${msg.video_url}" alt="Avatar" class="selected-avatar">` : marked.parse(msg.respuesta)}<button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button></div>`).join('');
    scrollToBottom();
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, nombre: chat.nombre, timestamp: chat.timestamp, mensajes: chat.mensajes }));
    getElements('#chat-list li').forEach(li => li.classList.remove('selected'));
    getElement(`#chat-list li[data-index="${index}"]`)?.classList.add('selected');
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const renombrarChat = index => {
    if (!confirm('¿Renombrar este chat?')) return;
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
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
        mostrarNotificacion(`Chat renombrado a "${nuevoNombre}"`, 'success');
    }
};

const eliminarChat = index => {
    if (!confirm('¿Eliminar este chat?')) return;
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    historial.splice(index, 1);
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id === index) {
        localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
        nuevaConversacion();
    }
    actualizarListaChats();
    mostrarNotificacion('Chat eliminado', 'success');
};

const nuevaConversacion = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container) container.innerHTML = '';
    const input = getElement('#input');
    if (input) input.value = '';
    localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
    mostrarNotificacion('Nuevo chat creado', 'success');
    scrollToBottom();
};

const limpiarChat = () => {
    if (!confirm('¿Limpiar el chat actual?')) return;
    nuevaConversacion();
};

const cargarConversacionActual = () => {
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox || !currentConversation.mensajes?.length) return;
    container.innerHTML = currentConversation.mensajes.map(msg => `<div class="user">${msg.pregunta}</div><div class="bot">${msg.video_url ? `<img src="${msg.video_url}" alt="Avatar" class="selected-avatar">` : marked.parse(msg.respuesta)}<button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button></div>`).join('');
    scrollToBottom();
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const exportarTxt = () => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.mensajes.length) {
        mostrarNotificacion('No hay mensajes para exportar', 'warning');
        return;
    }
    const text = currentConversation.mensajes.map(msg => `Pregunta: ${msg.pregunta}\nRespuesta: ${msg.respuesta}\n`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_${new Date().toLocaleString().replace(/[,:/]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    mostrarNotificacion('Chat exportado a TXT', 'success');
};

const exportarPdf = () => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.mensajes.length) {
        mostrarNotificacion('No hay mensajes para exportar', 'warning');
        return;
    }
    const doc = new jsPDF();
    doc.setFontSize(12);
    let y = 10;
    currentConversation.mensajes.forEach(msg => {
        doc.text(`Pregunta: ${msg.pregunta}`, 10, y);
        y += 10;
        let respuesta = msg.respuesta.replace(/[\r\n]+/g, ' ').substring(0, 200);
        doc.text(`Respuesta: ${respuesta}`, 10, y);
        y += 20;
        if (y > 270) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save(`chat_${new Date().toLocaleString().replace(/[,:/]/g, '-')}.pdf`);
    mostrarNotificacion('Chat exportado a PDF', 'success');
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', handleCopy);
        btn.addEventListener('click', handleCopy);
    });
};

const handleCopy = e => {
    const text = e.currentTarget.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
        mostrarNotificacion('Mensaje copiado al portapapeles', 'success');
    }).catch(error => {
        mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
    });
};

const sendMessage = async () => {
    const input = getElement('#input');
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const pregunta = input?.value.trim();
    if (!pregunta) {
        mostrarNotificacion('Por favor, escribe un mensaje', 'warning');
        return;
    }
    input.value = '';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Área de chat no encontrada', 'error');
        return;
    }
    container.classList.add('loading');
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    scrollToBottom();

    try {
        const response = await fetch('https://api.x.ai/v1/grok', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer YOUR_XAI_API_KEY' // Reemplaza con tu clave de API
            },
            body: JSON.stringify({
                model: 'llama-3-70b-instruct',
                messages: [{ role: 'user', content: pregunta }],
                max_tokens: 200,
                stream: true
            })
        });

        container.classList.remove('loading');
        if (!response.ok) throw new Error(`Error en la API de Grok: ${response.statusText}`);

        const botDiv = document.createElement('div');
        botDiv.classList.add('bot', 'typing');
        container.appendChild(botDiv);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let respuesta = '';

        async function read() {
            const { done, value } = await reader.read();
            if (done) {
                botDiv.classList.remove('typing');
                botDiv.innerHTML = marked.parse(respuesta) + `<button class="copy-btn" data-text="${respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                if (window.Prism) Prism.highlightAllUnder(botDiv);
                speakText(respuesta);
                guardarMensaje(pregunta, respuesta);
                scrollToBottom();
                addCopyButtonListeners();
                return;
            }
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.choices[0].delta.content) {
                            respuesta += parsed.choices[0].delta.content;
                            botDiv.innerHTML = marked.parse(respuesta);
                            scrollToBottom();
                        }
                    } catch (e) {
                        console.error('Error parsing chunk:', e);
                    }
                }
            }
            read();
        }
        read();
    } catch (error) {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al enviar mensaje a Grok: ${error.message}`, 'error');
        container.removeChild(userDiv);
    }
};

const generarQuiz = async () => {
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Área de chat no encontrada', 'error');
        return;
    }
    container.classList.add('loading');
    try {
        const response = await fetch('https://api.x.ai/v1/grok', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer YOUR_XAI_API_KEY' // Reemplaza con tu clave de API
            },
            body: JSON.stringify({
                model: 'llama-3-70b-instruct',
                messages: [{ role: 'user', content: `Genera un quiz de nivel ${nivel} sobre temas generales con una pregunta y 4 opciones, indicando cuál es la correcta.` }],
                max_tokens: 300
            })
        });

        container.classList.remove('loading');
        if (!response.ok) throw new Error(`Error en la API de Grok: ${response.statusText}`);

        const data = await response.json();
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        let quizHtml = `<strong>Quiz: ${data.choices[0].message.content}</strong><div class="quiz-options">`;
        const opciones = data.choices[0].message.content.match(/([A-D]\.\s.*?(?=\s[A-D]\.|$))/g) || [];
        const correcta = data.choices[0].message.content.match(/Correcta:\s*([A-D])/i)?.[1] || 'A';
        opciones.forEach((opcion, index) => {
            const letra = String.fromCharCode(65 + index);
            quizHtml += `<button class="quiz-option" data-correct="${letra === correcta}" aria-label="Opción ${letra}">${opcion}</button>`;
        });
        quizHtml += '</div>';
        botDiv.innerHTML = quizHtml + `<button class="copy-btn" data-text="${data.choices[0].message.content}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        getElements('.quiz-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const isCorrect = btn.dataset.correct === 'true';
                mostrarNotificacion(isCorrect ? '¡Correcto!' : 'Incorrecto, intenta de nuevo.', isCorrect ? 'success' : 'error');
                if (!isCorrect) return;
                getElements('.quiz-option').forEach(opt => opt.disabled = true);
            });
        });
        speakText(data.choices[0].message.content);
        guardarMensaje('Generar quiz', data.choices[0].message.content);
        addCopyButtonListeners();
    } catch (error) {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al generar quiz con Grok: ${error.message}`, 'error');
    }
};

const recomendarTema = async () => {
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Área de chat no encontrada', 'error');
        return;
    }
    container.classList.add('loading');
    try {
        const response = await fetch('https://api.x.ai/v1/grok', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer YOUR_XAI_API_KEY' // Reemplaza con tu clave de API
            },
            body: JSON.stringify({
                model: 'llama-3-70b-instruct',
                messages: [{ role: 'user', content: `Recomienda un tema de programación de nivel ${nivel} para estudiar.` }],
                max_tokens: 200
            })
        });

        container.classList.remove('loading');
        if (!response.ok) throw new Error(`Error en la API de Grok: ${response.statusText}`);

        const data = await response.json();
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = marked.parse(data.choices[0].message.content) + `<button class="copy-btn" data-text="${data.choices[0].message.content}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        speakText(data.choices[0].message.content);
        guardarMensaje('Recomendar tema', data.choices[0].message.content);
        if (window.Prism) Prism.highlightAll();
        addCopyButtonListeners();
    } catch (error) {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al recomendar tema con Grok: ${error.message}`, 'error');
    }
};

const toggleModo = () => {
    document.body.classList.toggle('modo-claro');
    const modoBtn = getElement('#modo-btn');
    if (modoBtn) {
        modoBtn.innerHTML = `<i class="fas ${document.body.classList.contains('modo-claro') ? 'fa-moon' : 'fa-sun'}"></i>`;
        modoBtn.setAttribute('data-tooltip', document.body.classList.contains('modo-claro') ? 'Modo oscuro' : 'Modo claro');
    }
    localStorage.setItem('modo', document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro');
    mostrarNotificacion(`Modo ${document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro'} activado`, 'success');
};

const setNivel = nivel => {
    document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
    getElements('.nivel-btn').forEach(btn => btn.classList.remove('active'));
    getElement(`.nivel-btn[data-nivel="${nivel}"]`)?.classList.add('active');
    localStorage.setItem('nivel', nivel);
    mostrarNotificacion(`Nivel ${nivel} seleccionado`, 'success');
};

const toggleMenu = (selector, toggleBtn) => {
    const section = getElement(selector);
    const isActive = section.classList.contains('active');
    section.classList.toggle('active');
    toggleBtn.setAttribute('aria-expanded', !isActive);
    toggleBtn.innerHTML = `<i class="fas ${!isActive ? 'fa-times' : 'fa-bars'}"></i>`;
};

document.addEventListener('DOMContentLoaded', () => {
    cargarAvatares();
    actualizarListaChats();
    cargarConversacionActual();

    const nivel = localStorage.getItem('nivel') || 'intermedio';
    setNivel(nivel);

    const modo = localStorage.getItem('modo') || 'oscuro';
    if (modo === 'claro') {
        document.body.classList.add('modo-claro');
        const modoBtn = getElement('#modo-btn');
        if (modoBtn) {
            modoBtn.innerHTML = `<i class="fas fa-moon"></i>`;
            modoBtn.setAttribute('data-tooltip', 'Modo oscuro');
        }
    }

    getElement('#modo-btn')?.addEventListener('click', toggleModo);
    getElement('#mute-btn')?.addEventListener('click', toggleVoz);
    getElement('#voice-btn')?.addEventListener('click', startVoiceRecognition);
    getElement('#speech-btn')?.addEventListener('click', pauseSpeech);
    getElement('#send-btn')?.addEventListener('click', sendMessage);
    getElement('#new-chat-btn')?.addEventListener('click', nuevaConversacion);
    getElement('#btn-clear')?.addEventListener('click', limpiarChat);
    getElement('#exportTxtBtn')?.addEventListener('click', exportarTxt);
    getElement('#exportPdfBtn')?.addEventListener('click', exportarPdf);
    getElement('#quiz-btn')?.addEventListener('click', generarQuiz);
    getElement('#recommend-btn')?.addEventListener('click', recomendarTema);

    getElements('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => setNivel(btn.dataset.nivel));
    });

    getElements('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            getElements('.tab-btn').forEach(tab => {
                tab.classList.remove('active');
                tab.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            getElements('.tab-content > div').forEach(content => content.classList.remove('active'));
            getElement(`.${btn.dataset.tab}`)?.classList.add('active');
        });
    });

    getElement('.menu-toggle')?.addEventListener('click', () => toggleMenu('.left-section', getElement('.menu-toggle')));
    getElement('.menu-toggle-right')?.addEventListener('click', () => toggleMenu('.right-section', getElement('.menu-toggle-right')));

    getElement('#input')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') sendMessage();
    });

    window.addEventListener('resize', scrollToBottom);
});