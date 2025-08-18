let vozActiva = true, isListening = false, recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
let isIAVoicePaused = false;
const { jsPDF } = window.jspdf;

const getElement = selector => document.querySelector(selector);
const getElements = selector => document.querySelectorAll(selector);

const mostrarNotificacion = (mensaje, tipo = 'info') => {
    const card = getElement('#notification-card');
    if (!card) return;
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
        isIAVoicePaused = false;
        updateIAVoiceToggle();
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
            isIAVoicePaused = false;
            updateIAVoiceToggle();
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
        isIAVoicePaused = false;
        updateIAVoiceToggle();
    });
};

const toggleVoiceUser = () => {
    if (!('webkitSpeechRecognition' in window)) {
        mostrarNotificacion('Reconocimiento de voz no soportado', 'error');
        return;
    }
    if (isListening) {
        recognition.stop();
        isListening = false;
        const btn = getElement('#toggle-voice-user');
        if (btn) {
            btn.querySelector('i').classList.remove('fa-microphone-slash');
            btn.querySelector('i').classList.add('fa-microphone');
        }
        mostrarNotificacion('Voz usuario desactivada');
    } else {
        recognition = new webkitSpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.onresult = event => {
            const transcript = event.results[0][0].transcript;
            const input = getElement('#input');
            if (input) input.value = transcript;
            sendMessage();
        };
        recognition.start();
        isListening = true;
        const btn = getElement('#toggle-voice-user');
        if (btn) {
            btn.querySelector('i').classList.remove('fa-microphone');
            btn.querySelector('i').classList.add('fa-microphone-slash');
        }
        mostrarNotificacion('Voz usuario activada');
    }
};

const toggleIAVoice = () => {
    if (currentAudio) {
        if (isIAVoicePaused) {
            currentAudio.play();
            isIAVoicePaused = false;
            mostrarNotificacion('Voz IA reanudada');
        } else {
            currentAudio.pause();
            isIAVoicePaused = true;
            mostrarNotificacion('Voz IA pausada');
        }
        updateIAVoiceToggle();
    }
};

const updateIAVoiceToggle = () => {
    const btn = getElement('#toggle-ia-voice');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-pause', !isIAVoicePaused);
            icon.classList.toggle('fa-play', isIAVoicePaused);
        }
    }
};

const newChat = () => {
    const container = getElement('#chatbox .message-container');
    if (container) {
        container.innerHTML = '';
        mostrarNotificacion('Nuevo chat iniciado');
    }
};

const deleteChat = () => {
    const container = getElement('#chatbox .message-container');
    if (container) {
        container.innerHTML = '';
        mostrarNotificacion('Chat eliminado');
    }
};

const exportarTxt = () => {
    const messages = getElements('.message-container > div');
    let txtContent = '';
    messages.forEach(msg => {
        const isUser = msg.classList.contains('user');
        txtContent += `${isUser ? 'Usuario' : 'Bot'}: ${msg.textContent}\n`;
    });
    const blob = new Blob([txtContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat.txt';
    a.click();
    URL.revokeObjectURL(url);
};

const exportarPdf = () => {
    const doc = new jsPDF();
    let y = 10;
    const messages = getElements('.message-container > div');
    messages.forEach(msg => {
        const isUser = msg.classList.contains('user');
        doc.text(`${isUser ? 'Usuario' : 'Bot'}: ${msg.textContent}`, 10, y);
        y += 10;
        if (y > 280) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save('chat.pdf');
};

const sendMessage = () => {
    const input = getElement('#input');
    const messageContainer = getElement('.message-container');
    if (!input || !messageContainer) return;
    const pregunta = input.value.trim();
    if (!pregunta) return;
    const userMsg = document.createElement('div');
    userMsg.classList.add('user');
    userMsg.textContent = pregunta;
    messageContainer.appendChild(userMsg);
    scrollToBottom();
    input.value = '';
    fetch('/preguntar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta })
    }).then(res => {
        if (!res.ok) throw new Error('Error en la solicitud');
        return res.json();
    }).then(data => {
        if (data.respuesta) {
            const botMsg = document.createElement('div');
            botMsg.classList.add('bot');
            botMsg.textContent = data.respuesta;
            messageContainer.appendChild(botMsg);
            scrollToBottom();
            speakText(data.respuesta);
        } else if (data.error) {
            mostrarNotificacion(`Error: ${data.error}`, 'error');
        }
    }).catch(error => {
        mostrarNotificacion(`Error: ${error.message}`, 'error');
    });
};

document.addEventListener('DOMContentLoaded', () => {
    // Cargar progreso y bienvenida
    fetch('/progreso').then(res => {
        if (!res.ok) throw new Error('Error al cargar progreso');
        return res.json();
    }).then(data => {
        if (data.bienvenida) {
            const messageContainer = getElement('.message-container');
            if (messageContainer) {
                const botMsg = document.createElement('div');
                botMsg.classList.add('bot');
                botMsg.textContent = data.bienvenida;
                messageContainer.appendChild(botMsg);
                scrollToBottom();
                speakText(data.bienvenida);
            }
        }
    }).catch(error => {
        mostrarNotificacion(`Error al cargar bienvenida: ${error.message}`, 'error');
    });

    // Cargar avatares
    fetch('/avatars').then(res => {
        if (!res.ok) throw new Error('Error al cargar avatares');
        return res.json();
    }).then(data => {
        const avatarOptions = getElement('#avatar-options');
        if (!avatarOptions) return;
        data.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.alt = `Avatar ${avatar.nombre}`;
            img.title = avatar.nombre;
            img.dataset.avatarId = avatar.avatar_id;
            img.addEventListener('click', () => {
                selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                getElements('.avatar-selection img').forEach(i => i.classList.remove('selected'));
                img.classList.add('selected');
            });
            if (avatar.avatar_id === selectedAvatar) img.classList.add('selected');
            avatarOptions.appendChild(img);
        });
    }).catch(error => {
        mostrarNotificacion(`Error al cargar avatares: ${error.message}`, 'error');
    });

    // Event listeners
    const toggleVoiceBtn = getElement('#toggle-voice-user');
    if (toggleVoiceBtn) toggleVoiceBtn.addEventListener('click', toggleVoiceUser);

    const toggleIABtn = getElement('#toggle-ia-voice');
    if (toggleIABtn) toggleIABtn.addEventListener('click', toggleIAVoice);

    const newChatBtn = getElement('#new-chat');
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);

    const deleteChatBtn = getElement('#delete-chat');
    if (deleteChatBtn) deleteChatBtn.addEventListener('click', deleteChat);

    const exportTxtBtn = getElement('#export-txt');
    if (exportTxtBtn) exportTxtBtn.addEventListener('click', exportarTxt);

    const exportPdfBtn = getElement('#export-pdf');
    if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportarPdf);

    const toggleDarkModeBtn = getElement('#toggle-dark-mode');
    if (toggleDarkModeBtn) {
        toggleDarkModeBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            mostrarNotificacion(document.body.classList.contains('modo-claro') ? 'Modo claro activado' : 'Modo oscuro activado');
        });
    }

    const sendBtn = getElement('#send');
    const input = getElement('#input');
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);
    if (input) {
        input.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
    }

    // Niveles
    getElements('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const nivel = btn.dataset.nivel;
            fetch('/cambiar_nivel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nivel })
            }).then(res => {
                if (!res.ok) throw new Error('Error al cambiar nivel');
                return res.json();
            }).then(data => {
                mostrarNotificacion(data.mensaje);
                document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
            }).catch(error => {
                mostrarNotificacion(`Error: ${error.message}`, 'error');
            });
        });
    });

    // Tooltips mejorados
    getElements('[data-tooltip]').forEach(btn => {
        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = btn.dataset.tooltip;
        document.body.appendChild(tooltip);

        btn.addEventListener('mouseenter', (e) => {
            const rect = btn.getBoundingClientRect();
            tooltip.style.top = `${rect.top + rect.height + 5}px`;
            tooltip.style.left = `${rect.left + rect.width / 2}px`;
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });

        btn.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });

        btn.addEventListener('focus', (e) => {
            const rect = btn.getBoundingClientRect();
            tooltip.style.top = `${rect.top + rect.height + 5}px`;
            tooltip.style.left = `${rect.left + rect.width / 2}px`;
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });

        btn.addEventListener('blur', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });
    });
});