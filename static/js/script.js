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
        <button onclick="this.parentElement.classList.remove('active')">Cerrar</button>
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
                ctx.fillStyle = 'red';
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
        };
        speechSynthesis.speak(utterance);
        currentAudio = utterance;
    });
};

const pauseSpeech = () => {
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        mostrarNotificacion('Voz pausada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = true;
            btnResumeSpeech.disabled = false;
        }
    } else if ('speechSynthesis' in window && currentAudio) {
        speechSynthesis.pause();
        mostrarNotificacion('Voz pausada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = true;
            btnResumeSpeech.disabled = false;
        }
    }
};

const resumeSpeech = () => {
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    if (currentAudio instanceof Audio) {
        currentAudio.play();
        mostrarNotificacion('Voz reanudada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = false;
            btnResumeSpeech.disabled = true;
        }
    } else if ('speechSynthesis' in window && currentAudio && speechSynthesis.paused) {
        speechSynthesis.resume();
        mostrarNotificacion('Voz reanudada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = false;
            btnResumeSpeech.disabled = true;
        }
    }
};

const stopSpeech = () => {
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
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
            if (btnStartVoice && btnStopVoice && btnPauseSpeech && btnResumeSpeech) {
                btnStartVoice.disabled = false;
                btnStopVoice.disabled = true;
                btnPauseSpeech.disabled = true;
                btnResumeSpeech.disabled = true;
            }
            mostrarNotificacion('Voz y reconocimiento detenidos', 'info');
        } catch (error) {
            mostrarNotificacion(`Error al detener voz: ${error.message}`, 'error');
        }
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
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
                { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png' },
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
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png' },
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
        mostrarNotificacion('No hay mensajes para exportar', 'error');
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
        mostrarNotificacion('No hay mensajes para exportar', 'error');
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
        btn.addEventListener('click', () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Mensaje copiado al portapapeles', 'success');
            }).catch(error => {
                mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
            });
        });
    });
};

const sendMessage = () => {
    const input = getElement('#input');
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'basico';
    const pregunta = input?.value.trim();
    if (!pregunta) return;
    input.value = '';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.classList.add('loading');
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    scrollToBottom();

    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, usuario: 'anonimo', avatar_id: selectedAvatar, nivel, max_length: 200 })
    }).then(res => {
        container.classList.remove('loading');
        if (!res.ok) throw new Error(`Error en /respuesta: ${res.statusText}`);
        if (res.headers.get('content-type') === 'text/event-stream') {
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot', 'typing');
            container.appendChild(botDiv);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let respuesta = '';
            function read() {
                reader.read().then(({ done, value }) => {
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
                    respuesta += chunk;
                    botDiv.innerHTML = marked.parse(respuesta);
                    scrollToBottom();
                    read();
                }).catch(error => {
                    botDiv.classList.remove('typing');
                    mostrarNotificacion(`Error en streaming: ${error.message}`, 'error');
                });
            }
            read();
        } else {
            res.json().then(data => {
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                } else {
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    let respuestaHtml = marked.parse(data.respuesta);
                    if (data.sugerencias?.length) {
                        respuestaHtml += `<div class="suggestions"><strong>¿Qué más quieres saber?</strong> ${data.sugerencias.map(tema => `<a href="#" onclick="document.querySelector('#search-input').value='${tema}'; buscarTema(); return false;">${tema}</a>`).join('')}</div>`;
                    }
                    botDiv.innerHTML = respuestaHtml + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                    container.appendChild(botDiv);
                    scrollToBottom();
                    if (window.Prism) Prism.highlightAllUnder(botDiv);
                    speakText(data.respuesta);
                    guardarMensaje(pregunta, data.respuesta);
                    addCopyButtonListeners();
                }
            }).catch(error => {
                mostrarNotificacion(`Error al procesar respuesta: ${error.message}`, 'error');
            });
        }
    }).catch(error => {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al enviar mensaje: ${error.message}`, 'error');
        container.removeChild(userDiv);
    });
};

const buscarTema = () => {
    const query = getElement('#search-input')?.value.trim().toLowerCase();
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'basico';
    if (!query) {
        mostrarNotificacion('Ingresa una palabra clave para buscar.', 'error');
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) return;
    container.classList.add('loading');
    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: `Explica ${query}`, usuario: 'anonimo', avatar_id: selectedAvatar, nivel, max_length: 200 })
    }).then(res => {
        container.classList.remove('loading');
        if (!res.ok) throw new Error(`Error en /respuesta: ${res.statusText}`);
        res.json().then(data => {
            if (data.error) {
                mostrarNotificacion(data.error, 'error');
            } else {
                const botDiv = document.createElement('div');
                botDiv.classList.add('bot');
                let respuestaHtml = marked.parse(data.respuesta);
                if (data.sugerencias?.length) {
                    respuestaHtml += `<div class="suggestions"><strong>¿Qué más quieres saber?</strong> ${data.sugerencias.map(tema => `<a href="#" onclick="document.querySelector('#search-input').value='${tema}'; buscarTema(); return false;">${tema}</a>`).join('')}</div>`;
                }
                botDiv.innerHTML = respuestaHtml + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                container.appendChild(botDiv);
                scrollToBottom();
                if (window.Prism) Prism.highlightAllUnder(botDiv);
                speakText(data.respuesta);
                guardarMensaje(`Explica ${query}`, data.respuesta);
                addCopyButtonListeners();
            }
        }).catch(error => {
            mostrarNotificacion(`Error en búsqueda: ${error.message}`, 'error');
        });
    }).catch(error => {
        container.classList.remove('loading');
        mostrarNotificacion(`Error en búsqueda: ${error.message}`, 'error');
    });
};

const responderQuiz = (opcion, respuesta_correcta, tema) => {
    fetch('/responder_quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ respuesta: opcion, respuesta_correcta, tema, usuario: 'anonimo' })
    }).then(res => res.json())
        .then(data => {
            const chatbox = getElement('#chatbox');
            const container = chatbox?.querySelector('.message-container');
            if (!container || !chatbox) return;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = marked.parse(data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(botDiv);
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(botDiv);
            speakText(data.respuesta);
            guardarMensaje(`Respuesta Quiz ${tema}`, data.respuesta);
            addCopyButtonListeners();
        }).catch(error => {
            mostrarNotificacion(`Error en quiz: ${error.message}`, 'error');
        });
};

const cargarAnalytics = () => {
    fetch('/analytics?usuario=anonimo', { cache: 'no-store' })
        .then(res => {
            if (!res.ok) throw new Error(`Error en /analytics: ${res.status} ${res.statusText}`);
            return res.json();
        })
        .then(data => {
            const container = getElement('#analytics-container');
            if (!container) {
                console.error('Elemento #analytics-container no encontrado');
                return;
            }
            if (!Array.isArray(data)) {
                console.error('Error al cargar analytics: data no es un arreglo', data);
                mostrarNotificacion('No se pudieron cargar las estadísticas. Intenta de nuevo.', 'error');
                container.innerHTML = '<p>No hay estadísticas disponibles.</p>';
                return;
            }
            container.innerHTML = data.map(item => `
                <div class="progress-bar">
                    <span>${item.tema}: ${Math.round(item.tasa_acierto * 100)}%</span>
                    <div class="bar" style="width: ${item.tasa_acierto * 100}%"></div>
                </div>
            `).join('');
        })
        .catch(error => {
            console.error('Error al cargar analytics:', error);
            mostrarNotificacion(`Error al cargar analytics: ${error.message}`, 'error');
            const container = getElement('#analytics-container');
            if (container) container.innerHTML = '<p>Error al cargar estadísticas.</p>';
        });
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        input: getElement('#input'),
        sendBtn: getElement('#send-btn'),
        voiceBtn: getElement('#voice-btn'),
        btnStartVoice: getElement('#btn-start-voice'),
        btnStopVoice: getElement('#btn-stop-voice'),
        btnPauseSpeech: getElement('#btn-pause-speech'),
        btnResumeSpeech: getElement('#btn-resume-speech'),
        chatbox: getElement('#chatbox'),
        toggleAprendizajeBtn: getElement('#toggle-aprendizaje'),
        modoBtn: getElement('#modo-btn'),
        exportTxtBtn: getElement('#exportTxtBtn'),
        exportPdfBtn: getElement('#exportPdfBtn'),
        clearBtn: getElement('#btn-clear'),
        newChatBtn: getElement('#new-chat-btn'),
        recommendBtn: getElement('#recommend-btn'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        searchBtn: getElement('#search-btn'),
        searchInput: getElement('#search-input'),
        tabButtons: getElements('.tab-btn'),
        quizBtn: getElement('#quiz-btn'),
        nivelBtns: getElements('.nivel-btn')
    };

    Object.entries(elements).forEach(([key, value]) => {
        if (!value && key !== 'tabButtons' && key !== 'nivelBtns') console.warn(`Elemento ${key} no encontrado en el DOM`);
    });

    cargarAvatares();
    actualizarListaChats();
    cargarConversacionActual();
    cargarAnalytics();

    if (elements.input && elements.chatbox) {
        elements.input.addEventListener('input', () => {
            scrollToBottom();
        });
        elements.input.addEventListener('focus', () => {
            setTimeout(() => {
                scrollToBottom();
                elements.input.scrollIntoView({ behavior: 'auto', block: 'end' });
            }, 500);
        });
    }

    const container = elements.chatbox?.querySelector('.message-container');
    if (container && elements.chatbox) {
        const observer = new MutationObserver(() => {
            scrollToBottom();
        });
        observer.observe(container, { childList: true, subtree: true });
    }

    if (window.visualViewport && elements.chatbox) {
        window.visualViewport.addEventListener('resize', () => {
            const viewportHeight = window.visualViewport.height;
            const windowHeight = window.innerHeight;
            const keyboardHeight = windowHeight - viewportHeight;
            elements.chatbox.style.height = `${viewportHeight - 100}px`;
            elements.chatbox.style.paddingBottom = `${Math.max(250, keyboardHeight + 50)}px`;
            scrollToBottom();
        });
    }

    if (elements.sendBtn && elements.input) {
        elements.sendBtn.addEventListener('click', sendMessage);
        elements.input.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
    }

    if (elements.clearBtn) {
        elements.clearBtn.addEventListener('click', limpiarChat);
    }

    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener('click', nuevaConversacion);
    }

    if (elements.recommendBtn) {
        elements.recommendBtn.addEventListener('click', () => {
            fetch('/recommend?usuario=anonimo', { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    const chatbox = elements.chatbox;
                    const container = chatbox?.querySelector('.message-container');
                    if (!container || !chatbox) return;
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    const recomendacion = `Te recomiendo estudiar: ${data.recomendacion}`;
                    botDiv.innerHTML = marked.parse(recomendacion) + `<button class="copy-btn" data-text="${recomendacion}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                    container.appendChild(botDiv);
                    scrollToBottom();
                    if (window.Prism) Prism.highlightAllUnder(botDiv);
                    speakText(recomendacion);
                    guardarMensaje('Recomendación', recomendacion);
                    addCopyButtonListeners();
                }).catch(error => mostrarNotificacion(`Error al recomendar tema: ${error.message}`, 'error'));
        });
    }

    if (elements.searchBtn && elements.searchInput) {
        elements.searchBtn.addEventListener('click', buscarTema);
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') buscarTema();
        });
    }

    if (elements.quizBtn && elements.chatbox) {
        elements.quizBtn.addEventListener('click', () => {
            fetch('/quiz?usuario=anonimo', { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    const chatbox = elements.chatbox;
                    const container = chatbox?.querySelector('.message-container');
                    if (!container || !chatbox) return;
                    let opcionesHtml = '<div class="quiz-options">';
                    data.opciones.forEach((opcion, i) => {
                        opcionesHtml += `<button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${data.respuesta_correcta}" data-tema="${data.tema}">${i + 1}. ${opcion}</button>`;
                    });
                    opcionesHtml += '</div>';
                    const pregunta = `${data.pregunta}<br>Opciones:<br>${opcionesHtml}`;
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    botDiv.innerHTML = marked.parse(pregunta) + `<button class="copy-btn" data-text="${data.pregunta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                    container.appendChild(botDiv);
                    scrollToBottom();
                    guardarMensaje('Quiz', `${data.pregunta}\nOpciones: ${data.opciones.join(', ')}`);
                    getElements('.quiz-option').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const opcion = btn.dataset.opcion;
                            const respuestaCorrecta = btn.dataset.respuestaCorrecta;
                            const tema = btn.dataset.tema;
                            responderQuiz(opcion, respuestaCorrecta, tema);
                            getElements('.quiz-option').forEach(opt => opt.disabled = true);
                        });
                    });
                    if (window.Prism) Prism.highlightAllUnder(container);
                    addCopyButtonListeners();
                }).catch(error => {
                    mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
                });
        });
    }

    if (elements.tabButtons) {
        elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                elements.tabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
                getElement(`.${btn.dataset.tab}`).classList.add('active');
            });
        });
    }

    if (elements.nivelBtns) {
        elements.nivelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const nivel = btn.dataset.nivel;
                document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
                elements.nivelBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mostrarNotificacion(`Nivel cambiado a ${nivel}`, 'success');
            });
        });
    }

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            const modo = document.body.classList.contains('modo-claro') ? 'Claro' : 'Oscuro';
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            mostrarNotificacion(`Modo ${modo} activado`, 'success');
        });
    }

    if (elements.voiceBtn) {
        elements.voiceBtn.addEventListener('click', () => {
            vozActiva = !vozActiva;
            elements.voiceBtn.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
            mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
            if (!vozActiva) stopSpeech();
        });
    }

    if (elements.btnStartVoice && elements.btnStopVoice && elements.btnPauseSpeech && elements.btnResumeSpeech) {
        elements.btnStartVoice.addEventListener('click', () => {
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
            elements.btnStartVoice.disabled = true;
            elements.btnStopVoice.disabled = false;
            elements.btnPauseSpeech.disabled = true;
            elements.btnResumeSpeech.disabled = true;
            mostrarNotificacion('Reconocimiento de voz iniciado', 'success');

            recognition.onresult = event => {
                const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
                if (elements.input) elements.input.value = transcript;
                if (event.results[event.results.length - 1].isFinal) {
                    sendMessage();
                    recognition.stop();
                    isListening = false;
                    elements.btnStartVoice.disabled = false;
                    elements.btnStopVoice.disabled = true;
                }
            };

            recognition.onerror = event => {
                mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
                recognition.stop();
                isListening = false;
                elements.btnStartVoice.disabled = false;
                elements.btnStopVoice.disabled = true;
            };

            recognition.onend = () => {
                if (isListening) {
                    recognition.start();
                } else {
                    elements.btnStartVoice.disabled = false;
                    elements.btnStopVoice.disabled = true;
                }
            };
        });

        elements.btnStopVoice.addEventListener('click', stopSpeech);
        elements.btnPauseSpeech.addEventListener('click', pauseSpeech);
        elements.btnResumeSpeech.addEventListener('click', resumeSpeech);
    }

    if (elements.menuToggle && elements.menuToggleRight) {
        const toggleLeftMenu = (e) => {
            e.preventDefault();
            const leftSection = getElement('.left-section');
            if (leftSection) {
                leftSection.classList.toggle('active');
                elements.menuToggle.innerHTML = `<i class="fas fa-${leftSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                const rightSection = getElement('.right-section');
                if (rightSection && rightSection.classList.contains('active')) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        const toggleRightMenu = (e) => {
            e.preventDefault();
            const rightSection = getElement('.right-section');
            if (rightSection) {
                rightSection.classList.toggle('active');
                elements.menuToggleRight.innerHTML = `<i class="fas fa-${rightSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                const leftSection = getElement('.left-section');
                if (leftSection && leftSection.classList.contains('active')) {
                    leftSection.classList.remove('active');
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
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
            const menuToggle = getElement('.menu-toggle');
            const menuToggleRight = getElement('.menu-toggle-right');
            if (window.innerWidth <= 768) {
                if (leftSection && leftSection.classList.contains('active') &&
                    !leftSection.contains(e.target) &&
                    !menuToggle.contains(e.target)) {
                    leftSection.classList.remove('active');
                    leftSection.style.transform = 'translateX(-100%)';
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                }
                if (rightSection && rightSection.classList.contains('active') &&
                    !rightSection.contains(e.target) &&
                    !menuToggleRight.contains(e.target)) {
                    rightSection.classList.remove('active');
                    rightSection.style.transform = 'translateX(100%)';
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        document.addEventListener('click', closeMenusOnOutsideInteraction);
        document.addEventListener('touchstart', closeMenusOnOutsideInteraction, { passive: false });
    }

    if (elements.toggleAprendizajeBtn) {
        elements.toggleAprendizajeBtn.addEventListener('click', () => {
            const aprendizajeCard = getElement('#aprendizajeCard');
            if (aprendizajeCard) aprendizajeCard.classList.toggle('active');
        });
    }

    if (getElement('#learnBtn')) {
        getElement('#learnBtn').addEventListener('click', () => {
            const pregunta = getElement('#nuevaPregunta')?.value.trim();
            const respuesta = getElement('#nuevaRespuesta')?.value.trim();
            if (!pregunta || !respuesta) {
                mostrarNotificacion('Por favor, completa ambos campos.', 'error');
                return;
            }
            fetch('/aprender', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pregunta, respuesta, usuario: 'anonimo' })
            }).then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                    } else {
                        mostrarNotificacion('Conocimiento aprendido con éxito', 'success');
                        getElement('#nuevaPregunta').value = '';
                        getElement('#nuevaRespuesta').value = '';
                        getElement('#aprendizajeCard')?.classList.remove('active');
                    }
                })
                .catch(error => {
                    mostrarNotificacion(`Error al aprender: ${error.message}`, 'error');
                });
        });
    }

    if (elements.exportTxtBtn) {
        elements.exportTxtBtn.addEventListener('click', exportarTxt);
    }

    if (elements.exportPdfBtn) {
        elements.exportPdfBtn.addEventListener('click', exportarPdf);
    }

    if (getElement('#tema-filter')) {
        getElement('#tema-filter').addEventListener('change', () => {
            const tema = getElement('#tema-filter').value;
            if (tema) {
                getElement('#search-input').value = tema;
                buscarTema();
            }
        });
    }

    document.querySelectorAll('.left-section button, .nivel-btn').forEach(btn => {
        const tooltipText = btn.dataset.tooltip;
        if (!tooltipText) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = tooltipText;
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'rgba(0, 0, 0, 0.95)';
        tooltip.style.color = '#fff';
        tooltip.style.padding = '8px 12px';
        tooltip.style.borderRadius = '6px';
        tooltip.style.fontSize = '12px';
        tooltip.style.zIndex = '10000';
        tooltip.style.opacity = '0';
        tooltip.style.visibility = 'hidden';
        tooltip.style.transition = 'opacity 0.3s ease, visibility 0.3s ease';
        tooltip.style.pointerEvents = 'none';
        document.body.appendChild(tooltip);

        btn.addEventListener('mouseenter', (e) => {
            const rect = btn.getBoundingClientRect();
            tooltip.style.top = `${rect.top + rect.height / 2}px`;
            tooltip.style.left = `${rect.left + rect.width + 10}px`;
            tooltip.style.transform = 'translateY(-50%)';
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });

        btn.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });
    });
});