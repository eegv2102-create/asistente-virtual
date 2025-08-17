// script.js (Modificado: Eliminadas funciones de modo aprendizaje. Agregado mensaje bienvenida al cargar. Ajustes para nuevo layout, botones fusionados (toggle-voice-user para pause/resume voz usuario), diferenciados pause/play voz IA (pause-ia-voice, play-ia-voice). Funciones para nuevo/eliminar chat. Responsive handlers. Descargas TXT/PDF funcionan como antes.)
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

const toggleVoiceUser = () => {
    // Toggle para voz usuario (microfono)
    if (isListening) {
        recognition.stop();
        isListening = false;
        mostrarNotificacion('Voz usuario pausada');
    } else {
        startListening();
        isListening = true;
        mostrarNotificacion('Voz usuario activa');
    }
};

const pauseIAVoice = () => {
    if (currentAudio) currentAudio.pause();
    mostrarNotificacion('Voz IA pausada');
};

const playIAVoice = () => {
    if (currentAudio && currentAudio.paused) currentAudio.play();
    mostrarNotificacion('Voz IA reanudada');
};

const newChat = () => {
    // Limpiar chat actual
    getElement('#chatbox .message-container').innerHTML = '';
    mostrarNotificacion('Nuevo chat iniciado');
};

const deleteChat = () => {
    // Eliminar chat actual (limpiar)
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

document.addEventListener('DOMContentLoaded', () => {
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

    // Event listeners para nuevos botones
    getElement('#toggle-voice-user').addEventListener('click', toggleVoiceUser);
    getElement('#pause-ia-voice').addEventListener('click', pauseIAVoice);
    getElement('#play-ia-voice').addEventListener('click', playIAVoice);
    getElement('#new-chat').addEventListener('click', newChat);
    getElement('#delete-chat').addEventListener('click', deleteChat);
    getElement('#export-txt').addEventListener('click', exportarTxt);
    getElement('#export-pdf').addEventListener('click', exportarPdf);

    // Toggle dark mode (como antes, pero en historial controls)
    getElement('#toggle-dark-mode').addEventListener('click', () => {
        document.body.classList.toggle('modo-claro');
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
                document.body.className = `nivel-${nivel}`;
            });
        });
    });

    // Enviar pregunta
    getElement('#send').addEventListener('click', () => {
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
        });
    });

    // Responsive menu toggles si es necesario (para left/right en móvil)
    if (window.innerWidth <= 768) {
        // Agregar toggles si no están, pero asumimos se manejan con CSS position fixed y class active
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');
        // Añadir botones toggle si es necesario, pero por simplicidad, asumir touch/click abre/cierra
    }
});