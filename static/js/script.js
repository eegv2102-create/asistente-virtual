/* static/js/script.js */
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
    if (!vozActiva) {
        vozActiva = true;
        mostrarNotificacion('Voz activada', 'success');
    } else {
        vozActiva = false;
        mostrarNotificacion('Voz desactivada', 'success');
    }
};

const newChat = () => {
    if (confirm('¿Estás seguro de iniciar un nuevo chat? Se perderá el chat actual.')) {
        newChat();
        mostrarNotificacion('Nuevo chat iniciado', 'success');
    }
};

const deleteChat = () => {
    if (confirm('¿Estás seguro de eliminar el chat actual?')) {
        deleteChat();
        mostrarNotificacion('Chat eliminado', 'success');
    }
};

const changeLevel = (nivel) => {
    fetch('/cambiar_nivel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nivel })
    }).then(res => res.json())
        .then(data => {
            mostrarNotificacion(data.mensaje, 'success');
            document.body.className = `nivel-${nivel}`;
        });
};

const toggleDarkMode = () => {
    document.body.classList.toggle('modo-claro');
    mostrarNotificacion(document.body.classList.contains('modo-claro') ? 'Modo claro activado' : 'Modo oscuro activado', 'success');
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

    // Cargar avatares
    fetch('/avatars').then(res => res.json()).then(data => {
        const avatarOptions = getElement('#avatar-options');
        data.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.alt = avatar.nombre;
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
    getElement('#toggle-dark-mode').addEventListener('click', toggleDarkMode);
    getElement('#new-chat').addEventListener('click', newChat);
    getElement('#delete-chat').addEventListener('click', deleteChat);
    getElement('#export-txt').addEventListener('click', exportarTxt);
    getElement('#export-pdf').addEventListener('click', exportarPdf);
    getElement('#send').addEventListener('click', sendMessage);
    getElement('#input').addEventListener('keypress', e => {
        if (e.key === 'Enter') sendMessage();
    });
    getElements('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => changeLevel(btn.dataset.nivel));
    });

    // Tooltips
    document.querySelectorAll('.left-section button, .nivel-btn, .input-group button').forEach(btn => {
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