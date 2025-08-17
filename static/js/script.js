let vozActiva = true, isListening = false, recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
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

const toggleVoiceUser = () => {
    if (!('webkitSpeechRecognition' in window)) {
        mostrarNotificacion('Reconocimiento de voz no soportado', 'error');
        return;
    }
    if (isListening) {
        recognition.stop();
        isListening = false;
        getElement('#toggle-voice-user').querySelector('i').classList.remove('fa-microphone-slash');
        getElement('#toggle-voice-user').querySelector('i').classList.add('fa-microphone');
        mostrarNotificacion('Voz usuario desactivada');
    } else {
        recognition = new webkitSpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.onresult = event => {
            const transcript = event.results[0][0].transcript;
            getElement('#input').value = transcript;
            sendMessage();
        };
        recognition.start();
        isListening = true;
        getElement('#toggle-voice-user').querySelector('i').classList.remove('fa-microphone');
        getElement('#toggle-voice-user').querySelector('i').classList.add('fa-microphone-slash');
        mostrarNotificacion('Voz usuario activada');
    }
};

const pauseIAVoice = () => {
    if (currentAudio) {
        currentAudio.pause();
        mostrarNotificacion('Voz IA pausada');
    }
};

const playIAVoice = () => {
    if (currentAudio && currentAudio.paused) {
        currentAudio.play();
        mostrarNotificacion('Voz IA reanudada');
    }
};

const newChat = () => {
    getElement('#chatbox .message-container').innerHTML = '';
    mostrarNotificacion('Nuevo chat iniciado');
};

const deleteChat = () => {
    getElement('#chatbox .message-container').innerHTML = '';
    mostrarNotificacion('Chat eliminado');
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
    const pregunta = input.value.trim();
    if (!pregunta) return;
    const messageContainer = getElement('.message-container');
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
    }).then(res => res.json()).then(data => {
        if (data.respuesta) {
            const botMsg = document.createElement('div');
            botMsg.classList.add('bot');
            botMsg.textContent = data.respuesta;
            messageContainer.appendChild(botMsg);
            scrollToBottom();
            speakText(data.respuesta);
        }
    }).catch(error => {
        mostrarNotificacion(`Error: ${error.message}`, 'error');
    });
};

document.addEventListener('DOMContentLoaded', () => {
    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/js/sw.js').then(reg => {
            console.log('Service Worker registrado', reg);
        }).catch(err => {
            console.error('Error al registrar Service Worker', err);
        });
    }

    // Cargar progreso y bienvenida
    fetch('/progreso').then(res => res.json()).then(data => {
        if (data.bienvenida) {
            const messageContainer = getElement('.message-container');
            const botMsg = document.createElement('div');
            botMsg.classList.add('bot');
            botMsg.textContent = data.bienvenida;
            messageContainer.appendChild(botMsg);
            scrollToBottom();
            speakText(data.bienvenida);
        }
    });

    // Cargar avatares
    fetch('/avatars').then(res => res.json()).then(data => {
        const avatarOptions = getElement('#avatar-options');
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
    });

    // Event listeners
    getElement('#toggle-voice-user').addEventListener('click', toggleVoiceUser);
    getElement('#pause-ia-voice').addEventListener('click', pauseIAVoice);
    getElement('#play-ia-voice').addEventListener('click', playIAVoice);
    getElement('#new-chat').addEventListener('click', newChat);
    getElement('#delete-chat').addEventListener('click', deleteChat);
    getElement('#export-txt').addEventListener('click', exportarTxt);
    getElement('#export-pdf').addEventListener('click', exportarPdf);
    getElement('#toggle-dark-mode').addEventListener('click', () => {
        document.body.classList.toggle('modo-claro');
        mostrarNotificacion(document.body.classList.contains('modo-claro') ? 'Modo claro activado' : 'Modo oscuro activado');
    });
    getElement('#send').addEventListener('click', sendMessage);
    getElement('#input').addEventListener('keypress', e => {
        if (e.key === 'Enter') sendMessage();
    });
    getElement('#send-feedback').addEventListener('click', () => {
        const comentario = getElement('#feedback-input').value.trim();
        if (!comentario) {
            mostrarNotificacion('Por favor, escribe un comentario', 'error');
            return;
        }
        fetch('/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comentario })
        }).then(res => res.json()).then(data => {
            mostrarNotificacion(data.mensaje || data.error, data.error ? 'error' : 'success');
            getElement('#feedback-input').value = '';
        });
    });

    // Niveles
    getElements('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const nivel = btn.dataset.nivel;
            fetch('/cambiar_nivel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nivel })
            }).then(res => res.json()).then(data => {
                mostrarNotificacion(data.mensaje);
                document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
            });
        });
    });

    // Tooltips
    getElements('[data-tooltip]').forEach(btn => {
        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = btn.dataset.tooltip;
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