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
        mostrarNotificacion('Voz pausada', 'success');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = true;
            btnResumeSpeech.disabled = false;
        }
    } else if ('speechSynthesis' in window && currentAudio) {
        speechSynthesis.pause();
        mostrarNotificacion('Voz pausada', 'success');
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
        mostrarNotificacion('Voz reanudada', 'success');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = false;
            btnResumeSpeech.disabled = true;
        }
    } else if ('speechSynthesis' in window && currentAudio && speechSynthesis.paused) {
        speechSynthesis.resume();
        mostrarNotificacion('Voz reanudada', 'success');
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
            mostrarNotificacion('Voz y reconocimiento detenidos', 'success');
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
        btn.removeEventListener('click', handleCopy); // Evitar múltiples listeners
        btn.addEventListener('click', handleCopy);
    });
};

const handleCopy = (e) => {
    const text = e.currentTarget.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
        mostrarNotificacion('Mensaje copiado al portapapeles', 'success');
    }).catch(error => {
        mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
    });
};

const sendMessage = () => {
    const input = getElement('#input');
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const tema = getElement('#tema-filter')?.value || '';
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

    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, usuario: 'anonimo', avatar_id: selectedAvatar, nivel, tema, max_length: 200 })
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
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const tema = getElement('#tema-filter')?.value || '';
    if (!query) {
        mostrarNotificacion('Ingresa una palabra clave para buscar.', 'warning');
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) return;
    container.classList.add('loading');
    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: `Explica ${query}`, usuario: 'anonimo', avatar_id: selectedAvatar, nivel, tema, max_length: 200 })
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
            mostrarNotificacion(`Error al procesar respuesta: ${error.message}`, 'error');
        });
    }).catch(error => {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al buscar tema: ${error.message}`, 'error');
    });
};

const generarQuiz = () => {
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const tema = getElement('#tema-filter')?.value || '';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Área de chat no encontrada', 'error');
        return;
    }
    container.classList.add('loading');
    fetch('/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nivel, tema })
    }).then(res => {
        container.classList.remove('loading');
        if (!res.ok) throw new Error(`Error en /quiz: ${res.statusText}`);
        res.json().then(data => {
            if (data.error) {
                mostrarNotificacion(data.error, 'error');
            } else {
                const botDiv = document.createElement('div');
                botDiv.classList.add('bot');
                let quizHtml = `<strong>Quiz: ${data.pregunta}</strong><div class="quiz-options">`;
                data.opciones.forEach((opcion, index) => {
                    quizHtml += `<button class="quiz-option" data-correct="${opcion.correcta}" aria-label="Opción ${index + 1}">${opcion.texto}</button>`;
                });
                quizHtml += '</div>';
                botDiv.innerHTML = quizHtml + `<button class="copy-btn" data-text="${data.pregunta}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>`;
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
                speakText(data.pregunta);
                guardarMensaje('Generar quiz', data.pregunta);
                addCopyButtonListeners();
            }
        }).catch(error => {
            mostrarNotificacion(`Error al procesar quiz: ${error.message}`, 'error');
        });
    }).catch(error => {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
    });
};

const recomendarTema = () => {
    const nivelBtnActive = getElement('.nivel-btn.active');
    const nivel = nivelBtnActive ? nivelBtnActive.dataset.nivel : 'intermedio';
    const tema = getElement('#tema-filter')?.value || '';
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        mostrarNotificacion('Error: Área de chat no encontrada', 'error');
        return;
    }
    container.classList.add('loading');
    fetch('/recomendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nivel, tema })
    }).then(res => {
        container.classList.remove('loading');
        if (!res.ok) throw new Error(`Error en /recomendar: ${res.statusText}`);
        res.json().then(data => {
            if (data.error) {
                mostrarNotificacion(data.error, 'error');
            } else {
                const botDiv = document.createElement('div');
                botDiv.classList.add('bot');
                const respuestaHtml = `Tema recomendado: ${data.tema}\nDescripción: ${data.descripcion}<div class="suggestions"><a href="#" onclick="document.querySelector('#search-input').value='${data.tema}'; buscarTema(); return false;">Explorar ${data.tema}</a></div>`;
                botDiv.innerHTML = respuestaHtml + `<button class="copy-btn" data-text="${data.tema}\n${data.descripcion}" aria-label="Copiar recomendación"><i class="fas fa-copy"></i></button>`;
                container.appendChild(botDiv);
                scrollToBottom();
                if (window.Prism) Prism.highlightAllUnder(botDiv);
                speakText(`Tema recomendado: ${data.tema}. ${data.descripcion}`);
                guardarMensaje('Recomendar tema', `${data.tema}\n${data.descripcion}`);
                addCopyButtonListeners();
            }
        }).catch(error => {
            mostrarNotificacion(`Error al procesar recomendación: ${error.message}`, 'error');
        });
    }).catch(error => {
        container.classList.remove('loading');
        mostrarNotificacion(`Error al recomendar tema: ${error.message}`, 'error');
    });
};

const toggleAprendizaje = () => {
    const card = getElement('#aprendizajeCard');
    if (!card) {
        console.error('Elemento #aprendizajeCard no encontrado');
        return;
    }
    card.classList.toggle('active');
    if (card.classList.contains('active')) {
        getElement('#nuevaPregunta')?.focus();
    }
};

const guardarAprendizaje = () => {
    const pregunta = getElement('#nuevaPregunta')?.value.trim();
    const respuesta = getElement('#nuevaRespuesta')?.value.trim();
    if (!pregunta || !respuesta) {
        mostrarNotificacion('Por favor, completa ambos campos.', 'warning');
        return;
    }
    fetch('/aprendizaje', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, respuesta })
    }).then(res => {
        if (!res.ok) throw new Error(`Error en /aprendizaje: ${res.statusText}`);
        return res.json();
    }).then(data => {
        if (data.error) {
            mostrarNotificacion(data.error, 'error');
        } else {
            mostrarNotificacion('Aprendizaje guardado con éxito', 'success');
            getElement('#nuevaPregunta').value = '';
            getElement('#nuevaRespuesta').value = '';
            getElement('#aprendizajeCard').classList.remove('active');
        }
    }).catch(error => {
        mostrarNotificacion(`Error al guardar aprendizaje: ${error.message}`, 'error');
    });
};

const toggleModo = () => {
    document.body.classList.toggle('modo-claro');
    const modoBtn = getElement('#modo-btn');
    if (modoBtn) {
        modoBtn.innerHTML = `<i class="fas ${document.body.classList.contains('modo-claro') ? 'fa-moon' : 'fa-sun'}"></i>`;
        modoBtn.setAttribute('data-tooltip', document.body.classList.contains('modo-claro') ? 'Modo oscuro' : 'Modo claro/oscuro');
    }
    localStorage.setItem('modo', document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro');
    mostrarNotificacion(`Modo ${document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro'} activado`, 'success');
};

const toggleVoz = () => {
    vozActiva = !vozActiva;
    const voiceBtn = getElement('#voice-btn');
    if (voiceBtn) {
        voiceBtn.innerHTML = `<i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>`;
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar voz' : 'Activar voz');
    }
    if (!vozActiva) stopSpeech();
    mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
};

const startVoiceRecognition = () => {
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    const input = getElement('#input');
    if (!input || !btnStartVoice || !btnStopVoice) {
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
    };
    recognition.onerror = event => {
        mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
        recognition.stop();
        isListening = false;
        btnStartVoice.disabled = false;
        btnStopVoice.disabled = true;
    };
    recognition.onend = () => {
        isListening = false;
        btnStartVoice.disabled = false;
        btnStopVoice.disabled = true;
    };
    recognition.start();
    isListening = true;
    btnStartVoice.disabled = true;
    btnStopVoice.disabled = false;
    mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
};

const stopVoiceRecognition = () => {
    if (isListening && recognition) {
        recognition.stop();
        isListening = false;
        const btnStartVoice = getElement('#btn-start-voice');
        const btnStopVoice = getElement('#btn-stop-voice');
        if (btnStartVoice && btnStopVoice) {
            btnStartVoice.disabled = false;
            btnStopVoice.disabled = true;
        }
        mostrarNotificacion('Reconocimiento de voz detenido', 'success');
    }
};

const cargarAnalytics = () => {
    const analyticsContainer = getElement('#analytics-container');
    if (!analyticsContainer) return;
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const totalMensajes = historial.reduce((acc, chat) => acc + (chat.mensajes?.length || 0), 0);
    const temas = historial.flatMap(chat => chat.mensajes?.map(msg => msg.pregunta.toLowerCase().match(/\b\w+\b/g) || [])).flat();
    const temasUnicos = [...new Set(temas)];
    analyticsContainer.innerHTML = `
        <p>Total de mensajes: ${totalMensajes}</p>
        <p>Temas únicos mencionados: ${temasUnicos.length}</p>
    `;
};

const inicializarEventos = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container) {
        const observer = new MutationObserver(scrollToBottom);
        observer.observe(container, { childList: true, subtree: true });
    }

    getElement('#input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    getElement('#send-btn')?.addEventListener('click', sendMessage);
    getElement('#search-btn')?.addEventListener('click', buscarTema);
    getElement('#search-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') buscarTema();
    });

    getElements('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            getElements('.nivel-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            mostrarNotificacion(`Nivel cambiado a ${btn.dataset.nivel}`, 'success');
        });
    });

    getElements('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            getElements('.tab-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
            getElement(`.${btn.dataset.tab}`)?.classList.add('active');
        });
    });

    getElement('#toggle-aprendizaje')?.addEventListener('click', toggleAprendizaje);
    getElement('#learnBtn')?.addEventListener('click', guardarAprendizaje);
    getElement('#modo-btn')?.addEventListener('click', toggleModo);
    getElement('#voice-btn')?.addEventListener('click', toggleVoz);
    getElement('#btn-start-voice')?.addEventListener('click', startVoiceRecognition);
    getElement('#btn-stop-voice')?.addEventListener('click', stopVoiceRecognition);
    getElement('#btn-pause-speech')?.addEventListener('click', pauseSpeech);
    getElement('#btn-resume-speech')?.addEventListener('click', resumeSpeech);
    getElement('#exportTxtBtn')?.addEventListener('click', exportarTxt);
    getElement('#exportPdfBtn')?.addEventListener('click', exportarPdf);
    getElement('#btn-clear')?.addEventListener('click', limpiarChat);
    getElement('#new-chat-btn')?.addEventListener('click', nuevaConversacion);
    getElement('#quiz-btn')?.addEventListener('click', generarQuiz);
    getElement('#recommend-btn')?.addEventListener('click', recomendarTema);

    getElement('.menu-toggle')?.addEventListener('click', () => {
        const leftSection = getElement('.left-section');
        const isActive = leftSection?.classList.toggle('active');
        getElement('.menu-toggle').setAttribute('aria-expanded', isActive ? 'true' : 'false');
        if (isActive && getElement('.right-section')?.classList.contains('active')) {
            getElement('.right-section').classList.remove('active');
            getElement('.menu-toggle-right').setAttribute('aria-expanded', 'false');
        }
    });

    getElement('.menu-toggle-right')?.addEventListener('click', () => {
        const rightSection = getElement('.right-section');
        const isActive = rightSection?.classList.toggle('active');
        getElement('.menu-toggle-right').setAttribute('aria-expanded', isActive ? 'true' : 'false');
        if (isActive && getElement('.left-section')?.classList.contains('active')) {
            getElement('.left-section').classList.remove('active');
            getElement('.menu-toggle').setAttribute('aria-expanded', 'false');
        }
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) {
            getElement('.left-section')?.classList.remove('active');
            getElement('.right-section')?.classList.remove('active');
            getElement('.menu-toggle')?.setAttribute('aria-expanded', 'false');
            getElement('.menu-toggle-right')?.setAttribute('aria-expanded', 'false');
        }
    });
};

document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('modo') === 'claro') {
        document.body.classList.add('modo-claro');
        const modoBtn = getElement('#modo-btn');
        if (modoBtn) {
            modoBtn.innerHTML = `<i class="fas fa-moon"></i>`;
            modoBtn.setAttribute('data-tooltip', 'Modo oscuro');
        }
    }
    cargarAvatares();
    cargarConversacionActual();
    actualizarListaChats();
    cargarAnalytics();
    inicializarEventos();
    getElement('#btn-pause-speech').disabled = true;
    getElement('#btn-resume-speech').disabled = true;
});