/**
 * --- 1. 初期設定とUI ---
 */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
const ui = {
    ja: {
        drop: "画像・動画をアップロード",
        placeholder: "ここにプレビューが表示されます",
        pip: "PiPを開始",
        reset: "リセット",
        duplicate: "このファイルは既に読み込まれています",
        iosNote: "【iPhone/iPad】動画の左上アイコンからPiPを開始してください。15秒送り/戻しで切り替え可能です。"
    },
    en: {
        drop: "Add images or videos",
        placeholder: "Preview appears here",
        pip: "Start PiP",
        reset: "Reset",
        duplicate: "Duplicate file detected",
        iosNote: "【iOS】Use the top-left icon for PiP. 15s seek buttons will switch items."
    }
};

const els = {
    drop: document.getElementById('label-drop'),
    placeholder: document.getElementById('placeholder-text'),
    pip: document.getElementById('pipBtn'),
    reset: document.getElementById('resetBtn'),
    canvas: document.getElementById('canvas'),
    video: document.getElementById('hiddenVideo'), 
    fileInput: document.getElementById('fileInput'),
    alert: document.getElementById('alert-box'),
    themeToggle: document.getElementById('themeToggle'),
    prev: document.getElementById('prevBtn'),
    next: document.getElementById('nextBtn'),
    container: document.getElementById('preview-container')
};

Object.keys(ui[lang]).forEach(key => { if (els[key]) els[key].textContent = ui[lang][key]; });

// iOS用案内表示
if (isIOS) {
    els.pip.style.display = 'none';
    const note = document.createElement('p');
    note.style.cssText = "font-size: 11px; opacity: 0.7; margin-top: 8px; text-align: center;";
    note.textContent = ui[lang].iosNote;
    els.container.after(note);
}

/**
 * --- 2. 状態管理 ---
 */
let loadedHashes = new Set();
let mediaItems = []; 
let currentIndex = 0;
let ctx = els.canvas.getContext('2d');
let maxBaseWidth = 0;
let maxBaseHeight = 0;

/**
 * --- 3. データベース ---
 */
const DB_NAME = "PiPAppDB";
const DB_VERSION = 1;

async function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
            if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "hash" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function calculateHash(file) {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadSavedData() {
    try {
        const db = await getDB();
        const themeTx = db.transaction("settings", "readonly");
        const themeReq = themeTx.objectStore("settings").get("theme");
        themeReq.onsuccess = () => { if (themeReq.result === 'dark') document.body.classList.add('dark-mode'); };

        const imgTx = db.transaction("images", "readonly");
        const imgReq = imgTx.objectStore("images").getAll();
        imgReq.onsuccess = () => {
            const savedData = imgReq.result;
            if (savedData && savedData.length > 0) {
                savedData.forEach(item => loadedHashes.add(item.hash));
                renderInitialMedia(savedData.map(item => item.blob));
            }
        };
    } catch (e) { console.error("Load failed:", e); }
}

loadSavedData();

/**
 * --- 4. ファイル処理 ---
 */
els.themeToggle.onclick = () => {
    const isDark = document.body.classList.toggle('dark-mode');
    saveTheme(isDark ? 'dark' : 'light');
};

async function saveTheme(mode) {
    const db = await getDB();
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put(mode, "theme");
}

document.getElementById('drop-zone').onclick = () => {
    els.fileInput.accept = "image/*,video/*";
    els.fileInput.click();
};

els.fileInput.onchange = (e) => handleFiles(e.target.files);

async function handleFiles(files) {
    const fileArray = Array.from(files);
    let hasDuplicate = false;
    const db = await getDB();

    for (const file of fileArray) {
        const hash = await calculateHash(file);
        if (loadedHashes.has(hash)) {
            hasDuplicate = true;
            continue;
        }
        loadedHashes.add(hash);
        const tx = db.transaction("images", "readwrite");
        tx.objectStore("images").put({ hash: hash, blob: file });
        createMediaObject(file);
    }
    if (hasDuplicate) showAlert(ui[lang].duplicate);
    els.fileInput.value = "";
}

function createMediaObject(file) {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        video.className = "preview-video-element";
        video.style.maxWidth = "100%";
        video.style.maxHeight = "100%";
        video.onloadedmetadata = () => {
            updateMaxSize(video.videoWidth, video.videoHeight);
            mediaItems.push({ type: 'video', el: video });
            finalizeMediaLoad();
        };
    } else if (file.type.startsWith('image/')) {
        const img = new Image();
        img.src = url;
        img.onload = () => {
            updateMaxSize(img.width, img.height);
            mediaItems.push({ type: 'image', el: img });
            finalizeMediaLoad();
        };
    }
}

function renderInitialMedia(blobs) {
    blobs.forEach(blob => createMediaObject(blob));
}

function updateMaxSize(w, h) {
    if (w > maxBaseWidth) maxBaseWidth = w;
    if (h > maxBaseHeight) maxBaseHeight = h;
}

function finalizeMediaLoad() {
    if (els.placeholder) els.placeholder.style.display = 'none';
    els.pip.disabled = false;
    showMedia(currentIndex);
    updateNavButtons();
}

function showAlert(msg) {
    els.alert.textContent = msg;
    els.alert.classList.remove('alert-hidden');
    setTimeout(() => els.alert.classList.add('alert-hidden'), 3000);
}

/**
 * --- 5. 表示・切り替えロジック ---
 */
async function showMedia(index) {
    if (mediaItems.length === 0) return;
    const isPipActive = !!document.pictureInPictureElement;
    
    currentIndex = (index + mediaItems.length) % mediaItems.length;
    const item = mediaItems[currentIndex];

    mediaItems.forEach(i => {
        if (i.type === 'video') {
            i.el.pause();
            if (i.el.parentNode === els.container) els.container.removeChild(i.el);
        }
    });

    if (item.type === 'image') {
        els.canvas.style.display = 'block';
        els.canvas.width = maxBaseWidth || 1280;
        els.canvas.height = maxBaseHeight || 720;
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
        const img = item.el;
        const ratio = Math.min(els.canvas.width / img.width, els.canvas.height / img.height);
        ctx.drawImage(img, (els.canvas.width - img.width * ratio) / 2, (els.canvas.height - img.height * ratio) / 2, img.width * ratio, img.height * ratio);
        
        // 画像をPiP可能にするため、Canvasからストリームを取得して隠しビデオに流す
        if (!els.video.srcObject) {
            els.video.srcObject = els.canvas.captureStream(30);
        }
        els.video.loop = true;
        els.video.play().catch(()=>{});
    } else {
        els.canvas.style.display = 'none';
        els.container.appendChild(item.el);
        item.el.play().catch(() => {});
    }

    updateMediaSession();
    updateNavButtons();

    if (isPipActive) {
        try {
            const target = item.type === 'video' ? item.el : els.video;
            if (document.pictureInPictureElement !== target) {
                await target.requestPictureInPicture();
            }
        } catch (e) { console.warn(e); }
    }
}

function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;

    const item = mediaItems[currentIndex];
    const targetVideo = item.type === 'video' ? item.el : els.video;

    navigator.mediaSession.metadata = new MediaMetadata({
        title: `${item.type === 'video' ? 'Video' : 'Image'} ${currentIndex + 1} / ${mediaItems.length}`,
        artist: 'Media PiP Player'
    });

    const updatePosition = () => {
        if (targetVideo.duration && !isNaN(targetVideo.duration)) {
            navigator.mediaSession.setPositionState({
                duration: targetVideo.duration,
                playbackRate: targetVideo.playbackRate,
                position: targetVideo.currentTime
            });
        }
    };

    navigator.mediaSession.setActionHandler('play', () => targetVideo.play());
    navigator.mediaSession.setActionHandler('pause', () => targetVideo.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => showMedia(currentIndex - 1));
    navigator.mediaSession.setActionHandler('nexttrack', () => showMedia(currentIndex + 1));
    
    // iOS/モバイル対策：15秒送り・戻しをスキップとして機能させる
    navigator.mediaSession.setActionHandler('seekbackward', () => showMedia(currentIndex - 1));
    navigator.mediaSession.setActionHandler('seekforward', () => showMedia(currentIndex + 1));
    
    navigator.mediaSession.setActionHandler('seekto', (details) => {
        targetVideo.currentTime = details.seekTime;
        updatePosition();
    });

    targetVideo.ontimeupdate = updatePosition;
}

function updateNavButtons() {
    els.prev.hidden = els.next.hidden = (mediaItems.length <= 1);
}

els.prev.onclick = (e) => { e.stopPropagation(); showMedia(currentIndex - 1); };
els.next.onclick = (e) => { e.stopPropagation(); showMedia(currentIndex + 1); };

/**
 * --- 6. PiP制御 ---
 */
els.pip.onclick = async () => {
    try {
        const item = mediaItems[currentIndex];
        const targetVideo = item.type === 'video' ? item.el : els.video;

        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            return;
        }

        await targetVideo.play();
        await targetVideo.requestPictureInPicture();
    } catch (e) { console.error("PiP Error:", e); }
};

/**
 * --- 7. リセット ---
 */
els.reset.onclick = async () => {
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(()=>{});

    mediaItems.forEach(item => {
        if (item.type === 'video') {
            item.el.pause();
            item.el.src = "";
            if (item.el.parentNode === els.container) els.container.removeChild(item.el);
        }
    });

    mediaItems = [];
    loadedHashes.clear();
    maxBaseWidth = 0; maxBaseHeight = 0; currentIndex = 0;
    els.video.pause(); els.video.srcObject = null;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    els.canvas.style.display = 'block';
    els.placeholder.style.display = 'block';
    els.pip.disabled = true;
    updateNavButtons();

    const db = await getDB();
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").clear();
};