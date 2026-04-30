/**
 * --- 1. デバイス判定 & 初期設定 ---
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
        iosNote: "※iOSでは動画内の左上のアイコンからPiPを開始してください"
    },
    en: {
        drop: "Add images or videos",
        placeholder: "Preview appears here",
        pip: "Start PiP",
        reset: "Reset",
        duplicate: "Duplicate file detected",
        iosNote: "Note: On iOS, tap the icon in the top-left of the video to start PiP"
    }
};

const els = {
    drop: document.getElementById('label-drop'),
    placeholder: document.getElementById('placeholder-text'),
    pip: document.getElementById('pipBtn'),
    reset: document.getElementById('resetBtn'),
    canvas: document.getElementById('canvas'),
    fileInput: document.getElementById('fileInput'),
    alert: document.getElementById('alert-box'),
    container: document.getElementById('preview-container')
};

// iOSの場合は独自PiPボタンを隠し、案内を出す
if (isIOS) {
    els.pip.style.display = 'none';
    const note = document.createElement('p');
    note.textContent = ui[lang].iosNote;
    note.style.fontSize = '12px';
    note.style.opacity = '0.7';
    els.container.after(note);
}

Object.keys(ui[lang]).forEach(key => { if (els[key]) els[key].textContent = ui[lang][key]; });

/**
 * --- 2. 状態管理 ---
 */
let loadedHashes = new Set();
let mediaItems = []; 
let currentIndex = 0;
let maxBaseWidth = 1280; // iOS安定用の基準サイズ
let maxBaseHeight = 720;

/**
 * --- 3. データベース & ハッシュ ---
 */
const DB_NAME = "PiPAppDB_v2";
const DB_VERSION = 1;

async function getDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
            if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "hash" });
        };
        request.onsuccess = () => resolve(request.result);
    });
}

async function calculateHash(file) {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * --- 4. 画像をiOS用「動画」に変換する関数 ---
 */
async function imageToVideoBlob(file) {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const tctx = canvas.getContext('2d');
            tctx.drawImage(img, 0, 0);
            
            const stream = canvas.captureStream(1);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' }); // iOS対応形式
            const chunks = [];
            recorder.ondataavailable = e => chunks.push(e.data);
            recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/mp4' }));
            
            recorder.start();
            setTimeout(() => recorder.stop(), 1000); // 1秒の動画にする
        };
    });
}

/**
 * --- 5. メディア処理 ---
 */
els.fileInput.onchange = (e) => handleFiles(e.target.files);
document.getElementById('drop-zone').onclick = () => {
    els.fileInput.accept = "image/*,video/*";
    els.fileInput.click();
};

async function handleFiles(files) {
    const db = await getDB();
    for (const file of Array.from(files)) {
        const hash = await calculateHash(file);
        if (loadedHashes.has(hash)) continue;
        
        loadedHashes.add(hash);
        let finalBlob = file;

        // iOSかつ画像の場合、動画に変換
        if (isIOS && file.type.startsWith('image/')) {
            finalBlob = await imageToVideoBlob(file);
        }

        const tx = db.transaction("media", "readwrite");
        tx.objectStore("media").put({ hash, blob: finalBlob, type: finalBlob.type });
        createMediaElement(finalBlob);
    }
}

function createMediaElement(blob) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    video.style.width = "100%";
    video.style.display = "none";
    
    video.onloadedmetadata = () => {
        mediaItems.push({ el: video });
        if (mediaItems.length === 1) showMedia(0);
        els.placeholder.style.display = 'none';
        updateNavButtons();
    };
    els.container.appendChild(video);
}

/**
 * --- 6. 表示 & MediaSession (切り替えロジック) ---
 */
function showMedia(index) {
    if (mediaItems.length === 0) return;
    const oldIndex = currentIndex;
    currentIndex = (index + mediaItems.length) % mediaItems.length;

    mediaItems.forEach((item, i) => {
        if (i === currentIndex) {
            item.el.style.display = "block";
            item.el.play().catch(() => {});
        } else {
            item.el.style.display = "none";
            item.el.pause();
        }
    });

    updateMediaSession();
}

function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const currentVideo = mediaItems[currentIndex].el;

    navigator.mediaSession.metadata = new MediaMetadata({
        title: `Item ${currentIndex + 1} / ${mediaItems.length}`,
        artist: 'Mobile PiP'
    });

    // 「次へ」「前へ」の標準設定（PC/Android用）
    navigator.mediaSession.setActionHandler('previoustrack', () => showMedia(currentIndex - 1));
    navigator.mediaSession.setActionHandler('nexttrack', () => showMedia(currentIndex + 1));

    // 「10/15秒送り・戻し」を「切り替え」に割り当てる (iOS PiP対策)
    navigator.mediaSession.setActionHandler('seekbackward', () => showMedia(currentIndex - 1));
    navigator.mediaSession.setActionHandler('seekforward', () => showMedia(currentIndex + 1));

    // 再生位置を報告 (iOSパネル表示に必要)
    currentVideo.ontimeupdate = () => {
        if (currentVideo.duration) {
            navigator.mediaSession.setPositionState({
                duration: currentVideo.duration,
                playbackRate: currentVideo.playbackRate,
                position: currentVideo.currentTime
            });
        }
    };
}

/**
 * --- 7. その他操作 ---
 */
function updateNavButtons() {
    document.getElementById('prevBtn').hidden = document.getElementById('nextBtn').hidden = mediaItems.length <= 1;
}

document.getElementById('prevBtn').onclick = () => showMedia(currentIndex - 1);
document.getElementById('nextBtn').onclick = () => showMedia(currentIndex + 1);

els.pip.onclick = async () => {
    if (mediaItems[currentIndex]) {
        try {
            await mediaItems[currentIndex].el.requestPictureInPicture();
        } catch (e) { console.error(e); }
    }
};

els.reset.onclick = async () => {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    mediaItems.forEach(item => {
        item.el.pause();
        item.el.src = "";
        item.el.remove();
    });
    mediaItems = [];
    loadedHashes.clear();
    els.placeholder.style.display = 'block';
    const db = await getDB();
    db.transaction("media", "readwrite").objectStore("media").clear();
};