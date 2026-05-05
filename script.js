(function() {
    // ================== 全局状态 ==================
    let currentBookType = null;
    let currentEpubBook = null;
    let currentRendition = null;
    let currentPdfDoc = null;
    let currentPdfTotalPages = 0;
    let currentPdfPageNum = 1;
    let currentTxtRaw = null;
    let currentTxtChunks = [];
    let smartChapterMode = false;
    let currentChapterIndex = 0;
    let currentFileName = "";
    let currentFontSize = 100;
    let currentTheme = "light";
    let isSidebarVisible = true;
    let currentBookUrlOrId = "";
    let currentCloudBookId = null; // 正在阅读的云端图书ID

    // IndexedDB 实例
    let db = null;
    const DB_NAME = "ZZXReaderDB";
    const STORE_NAME = "books";

    // 搜索相关
    let currentSearchTerm = "";
    let currentSearchMatches = [];
    let searchDebounceTimer = null;

    // Supabase 配置
    const SUPABASE_URL = 'https://jaceishrgswqigzworyr.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_siryMsxclwiR3CcbsRKD7A_p2NOZZFF';
    let supabase;
    let currentUser = null;

    // DOM 元素缓存（原有）
    const fileInput = document.getElementById('fileInput');
    const readerArea = document.getElementById('readerArea');
    const readerContainer = document.getElementById('readerContainer');
    const tocListEl = document.getElementById('tocList');
    const sidebar = document.getElementById('sidebar');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const fontPlusBtn = document.getElementById('fontPlusBtn');
    const fontMinusBtn = document.getElementById('fontMinusBtn');
    const smartChapterBtn = document.getElementById('smartChapterBtn');
    const chapterNavBar = document.getElementById('chapterNavBar');
    const prevChapterBtn = document.getElementById('prevChapterBtn');
    const nextChapterBtn = document.getElementById('nextChapterBtn');
    const chapterTitleSpan = document.getElementById('chapterTitle');
    const loadingToast = document.getElementById('loadingToast');
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const searchDropdown = document.getElementById('searchDropdown');
    const localMatchList = document.getElementById('localMatchList');
    const globalMatchList = document.getElementById('globalMatchList');
    const urlLoadBtn = document.getElementById('urlLoadBtn');
    const urlPanel = document.getElementById('urlPanel');
    const closeUrlPanelBtn = document.getElementById('closeUrlPanelBtn');
    const searchBar = document.querySelector('.search-bar');
    const userArea = document.getElementById('userArea');

    // 新增 UI 元素
    const cloudLibraryBtn = document.getElementById('cloudLibraryBtn');
    const myLibraryBtn = document.getElementById('myLibraryBtn');
    const authModal = document.getElementById('authModal');
    const uploadModal = document.getElementById('uploadModal');
    const cloudPanel = document.getElementById('cloudPanel');
    const myLibraryPanel = document.getElementById('myLibraryPanel');

    // 认证模式
    let authMode = 'login'; // 'login' or 'signup'

    // ================== 工具函数 ==================
    function showLoading(show, text = "加载中...") {
        if (show) {
            loadingToast.innerText = text;
            loadingToast.style.display = "block";
        } else {
            loadingToast.style.display = "none";
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    // DOM 就绪检测器（默认已就绪，保留）
    function domReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    // ================== IndexedDB ==================
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };
            request.onupgradeneeded = (e) => {
                const dbRef = e.target.result;
                if (!dbRef.objectStoreNames.contains(STORE_NAME)) {
                    dbRef.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };
        });
    }

    async function saveBookToIndexedDB(id, fileBlob, fileName, fileType) {
        if (!db) await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const record = { id, blob: fileBlob, fileName, fileType, timestamp: Date.now() };
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function loadBookFromIndexedDB(id) {
        if (!db) await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // ================== 全局配置 ==================
    function saveGlobalConfig() {
        const config = {
            fontSize: currentFontSize,
            theme: currentTheme,
            lastBookId: currentBookUrlOrId,
            lastBookType: currentBookType,
            lastFileName: currentFileName,
            smartChapterMode
        };
        localStorage.setItem("zzx_reader_config", JSON.stringify(config));
    }

    function loadGlobalConfig() {
        const raw = localStorage.getItem("zzx_reader_config");
        if (raw) {
            try {
                const cfg = JSON.parse(raw);
                currentFontSize = cfg.fontSize || 100;
                currentTheme = cfg.theme || "light";
                smartChapterMode = cfg.smartChapterMode || false;
                setTheme(currentTheme);
                adjustFontSize(0);
                return cfg;
            } catch (e) {}
        }
        return {};
    }

    // ================== 云端进度相关函数（先定义供 saveProgress 使用）==================
    function getCurrentProgressData() {
        if (currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                return { cfi: loc?.start?.cfi || null };
            } catch (e) { return null; }
        } else if (currentBookType === 'pdf') {
            return { page: currentPdfPageNum };
        } else if (currentBookType === 'txt') {
            if (smartChapterMode) return { chapterIndex: currentChapterIndex };
            const scrollPercent = readerContainer.scrollTop / (readerArea.scrollHeight - readerContainer.clientHeight);
            return { scrollRatio: isNaN(scrollPercent) ? 0 : scrollPercent };
        }
        return null;
    }

    async function saveCloudProgress() {
        if (!currentUser || !currentFileName) return;
        const progressData = getCurrentProgressData();
        if (!progressData) return;
        const bookId = currentCloudBookId || null;
        await supabase.from('reading_progress').upsert({
            user_id: currentUser.id,
            book_id: bookId,
            progress_data: progressData,
            updated_at: new Date()
        }, { onConflict: 'user_id, book_id' });
    }

    // 原始进度保存逻辑
    const _originalSaveProgressFn = async function() {
        if (!currentFileName) return;
        const key = `progress_${currentFileName}`;
        let progressData = { type: currentBookType, smartMode: smartChapterMode };
        if (currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                if (loc && loc.start && loc.start.cfi) progressData.cfi = loc.start.cfi;
            } catch (e) {}
        } else if (currentBookType === 'pdf' && currentPdfDoc) {
            progressData.page = currentPdfPageNum;
        } else if (currentBookType === 'txt') {
            if (smartChapterMode) {
                progressData.smartChapterIndex = currentChapterIndex;
            } else {
                const scrollPercent = readerContainer.scrollTop / (readerArea.scrollHeight - readerContainer.clientHeight);
                progressData.scrollRatio = isNaN(scrollPercent) ? 0 : scrollPercent;
            }
        }
        localStorage.setItem(key, JSON.stringify(progressData));
        saveGlobalConfig();
    };

    // 合并后的进度保存（本地 + 云端）
    async function saveProgress() {
        await _originalSaveProgressFn();
        if (currentUser && currentFileName) {
            await saveCloudProgress().catch(e => console.warn('云端进度保存失败', e));
        }
    }

    async function loadProgressForCurrent() {
        if (!currentFileName) return;
        const key = `progress_${currentFileName}`;
        const raw = localStorage.getItem(key);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.type === 'epub' && currentBookType === 'epub' && currentRendition && data.cfi) {
                await currentRendition.display(data.cfi);
            } else if (data.type === 'pdf' && currentBookType === 'pdf' && currentPdfDoc && data.page) {
                await renderPdfPage(data.page, true);
            } else if (data.type === 'txt' && currentBookType === 'txt') {
                if (data.smartMode !== undefined) smartChapterMode = data.smartMode;
                updateSmartChapterUI();
                if (smartChapterMode && currentTxtChunks.length > 0) {
                    let idx = data.smartChapterIndex || 0;
                    if (idx >= currentTxtChunks.length) idx = 0;
                    await renderTxtChapter(idx);
                } else if (!smartChapterMode && data.scrollRatio !== undefined) {
                    await renderFullTxtLazy();
                    setTimeout(() => {
                        const totalScroll = readerArea.scrollHeight - readerContainer.clientHeight;
                        readerContainer.scrollTop = totalScroll * data.scrollRatio;
                    }, 100);
                }
            }
        } catch (e) { console.warn(e); }
    }

    async function loadCloudProgressIfNeeded() {
        if (!currentUser || !supabase) return;
        const { data: progresses, error } = await supabase
            .from('reading_progress')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('updated_at', { ascending: false });
        if (error || !progresses.length) return;
        const latest = progresses[0];
        if (latest.book_id) {
            const { data: book } = await supabase.from('books').select('*').eq('id', latest.book_id).single();
            if (book) {
                // 不自动弹出确认，以免干扰，如果需要可取消注释
                // if (confirm(`发现云端阅读记录《${book.title}》，是否继续阅读？`)) {
                //     await loadCloudBook(latest.book_id);
                // }
            }
        }
    }

    // ================== 文本编码检测 ==================
    async function detectEncoding(buffer, sampleSize = 4096) {
        const encodings = ['utf-8', 'gbk', 'gb2312', 'big5', 'shift-jis', 'euc-kr'];
        const sample = buffer.slice(0, sampleSize);
        function scoreText(text) {
            let validChars = 0;
            for (let i = 0; i < text.length && i < 1000; i++) {
                const code = text.charCodeAt(i);
                if ((code >= 0x4E00 && code <= 0x9FFF) ||
                    (code >= 0x3040 && code <= 0x30FF) ||
                    (code >= 0xAC00 && code <= 0xD7AF) ||
                    (code >= 0x20 && code <= 0x7E) ||
                    (code === 0x0A || code === 0x0D || code === 0x09)) {
                    validChars++;
                }
            }
            return validChars / (text.length || 1);
        }
        let bestEncoding = 'utf-8';
        let bestScore = 0;
        for (const enc of encodings) {
            try {
                const decoder = new TextDecoder(enc, { fatal: false });
                const text = decoder.decode(sample);
                const score = scoreText(text);
                if (score > bestScore) {
                    bestScore = score;
                    bestEncoding = enc;
                }
                if (bestScore > 0.95) break;
            } catch (e) {}
        }
        return bestEncoding;
    }

    // ================== 智能章节分割 ==================
    function splitIntelligentChapters(text) {
        const unitCounter = {};
        const pattern = /^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])/gm;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const unit = match[2];
            unitCounter[unit] = (unitCounter[unit] || 0) + 1;
        }
        let bestUnit = null;
        let maxCount = 0;
        for (let u in unitCounter) {
            if (unitCounter[u] > maxCount) {
                maxCount = unitCounter[u];
                bestUnit = u;
            }
        }
        let splitPattern;
        if (bestUnit) {
            splitPattern = new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`, 'gm');
        } else {
            splitPattern = /^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        }
        const lines = text.split(/\r?\n/);
        const chapters = [];
        let currentTitle = "序言";
        let currentContent = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            splitPattern.lastIndex = 0;
            if (splitPattern.test(trimmed) && trimmed.length < 50) {
                if (currentContent.length) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
                currentTitle = trimmed;
                currentContent = [];
            } else {
                currentContent.push(line);
            }
        }
        if (currentContent.length) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
        if (chapters.length === 0) chapters = [{ title: "全文", content: text }];
        return chapters;
    }

    // ================== TXT 渲染 ==================
    async function renderTxtChapter(index) {
        if (!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(index, currentTxtChunks.length - 1);
        currentChapterIndex = Math.max(0, currentChapterIndex);
        const chapter = currentTxtChunks[currentChapterIndex];
        const htmlContent = `<div class="txt-viewer" style="font-size:${(currentFontSize / 100) * 1.1}rem; color:${currentTheme === 'dark' ? '#e2e8f0' : '#1e293b'}"><h3 style="margin-bottom:1rem;">${escapeHtml(chapter.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(chapter.content)}</div></div>`;
        readerArea.innerHTML = htmlContent;
        updateTocForSmartChapters();
        chapterTitleSpan.innerText = chapter.title;
        chapterNavBar.classList.remove('visible');
        readerContainer.scrollTop = 0;
        if (currentSearchTerm) performSearch(currentSearchTerm);
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if (!smartChapterMode || !currentTxtChunks.length) return;
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        ul.className = 'toc-list';
        currentTxtChunks.forEach((ch, idx) => {
            const li = document.createElement('li');
            li.className = 'toc-item';
            if (idx === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length > 30 ? ch.title.slice(0, 28) + '...' : ch.title;
            li.addEventListener('click', () => renderTxtChapter(idx));
            ul.appendChild(li);
        });
        tocListEl.appendChild(ul);
    }

    async function renderFullTxtLazy() {
        if (!currentTxtRaw) return;
        readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize / 100) * 1.1}rem; color:${currentTheme === 'dark' ? '#e2e8f0' : '#1e293b'}"></div>`;
        const containerDiv = readerArea.querySelector('.txt-viewer');
        const chunkSize = 50000;
        let index = 0;
        function renderNextChunk() {
            const nextChunk = currentTxtRaw.slice(index, index + chunkSize);
            if (nextChunk) {
                const textNode = document.createTextNode(nextChunk);
                containerDiv.appendChild(textNode);
                index += chunkSize;
                requestAnimationFrame(() => {
                    if (index < currentTxtRaw.length) renderNextChunk();
                    else {
                        if (currentSearchTerm) performSearch(currentSearchTerm);
                        saveProgress();
                    }
                });
            } else {
                saveProgress();
            }
        }
        renderNextChunk();
    }

    function buildTxtSimpleToc() {
        tocListEl.innerHTML = '<li class="toc-item">纯文本模式 · 无智能目录</li><li class="toc-item" style="color:#3b82f6" id="enableSmartBtnToc">🔍 开启智能章节</li>';
        const enableBtn = document.getElementById('enableSmartBtnToc');
        if (enableBtn) enableBtn.addEventListener('click', () => { toggleSmartChapterMode(true); });
    }

    function toggleSmartChapterMode(forceEnable) {
        if (currentBookType !== 'txt') return;
        smartChapterMode = forceEnable !== undefined ? forceEnable : !smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        updateSmartChapterUI();
        if (smartChapterMode && currentTxtChunks.length) {
            renderTxtChapter(currentChapterIndex);
        } else if (!smartChapterMode) {
            renderFullTxtLazy();
            chapterNavBar.classList.remove('visible');
            buildTxtSimpleToc();
        }
        saveProgress();
    }

    function updateSmartChapterUI() {
        if (currentBookType === 'txt' && smartChapterMode) {
            smartChapterBtn.classList.add('smart-active');
        } else {
            smartChapterBtn.classList.remove('smart-active');
        }
    }

    async function loadTxtSmartOrPlain(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'txt';
        currentFileName = filename;
        const encoding = await detectEncoding(arrayBuffer);
        console.log(`检测到文本编码：${encoding}`);
        const decoder = new TextDecoder(encoding);
        currentTxtRaw = decoder.decode(arrayBuffer);
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        const savedMode = localStorage.getItem(`txt_smart_mode_${filename}`);
        smartChapterMode = (savedMode === 'true') ? true : false;
        updateSmartChapterUI();
        if (smartChapterMode && currentTxtChunks.length > 0) {
            await renderTxtChapter(0);
        } else {
            await renderFullTxtLazy();
            chapterNavBar.classList.remove('visible');
            buildTxtSimpleToc();
        }
        bindScrollSave();
        await loadProgressForCurrent();
        if (currentSearchTerm) performSearch(currentSearchTerm);
    }

    // ================== EPUB 逻辑 ==================
    async function loadEpub(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'epub';
        currentFileName = filename;
        showLoading(true);
        try {
            const blob = new Blob([arrayBuffer], { type: "application/epub+zip" });
            const url = URL.createObjectURL(blob);
            currentEpubBook = ePub(url);
            currentRendition = currentEpubBook.renderTo("readerArea", { width: "100%", height: "100%", spread: "none", flow: "paginated" });
            await currentRendition.display();
            currentRendition.themes.register('light', { body: { background: '#fefefe', color: '#1e293b' } });
            currentRendition.themes.register('dark', { body: { background: '#11131f', color: '#e2e8f0' } });
            setTheme(currentTheme);
            currentRendition.themes.fontSize(currentFontSize + "%");
            const nav = await currentEpubBook.loaded.navigation;
            buildEpubToc(nav.toc);
            currentRendition.on('relocated', () => saveProgress());
            await loadProgressForCurrent();
            showLoading(false);
        } catch (e) {
            showLoading(false);
            readerArea.innerHTML = `<div class="empty-state">EPUB解析失败</div>`;
        }
    }

    function buildEpubToc(toc) {
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        const render = (items, parentUl) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'toc-item';
                li.innerText = item.label || '章节';
                if (item.href) li.addEventListener('click', () => currentRendition.display(item.href));
                parentUl.appendChild(li);
                if (item.subitems) render(item.subitems, parentUl);
            });
        };
        render(toc, ul);
        tocListEl.appendChild(ul);
    }

    // ================== PDF 逻辑 ==================
    async function loadPdf(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'pdf';
        currentFileName = filename;
        showLoading(true);
        try {
            const typedArray = new Uint8Array(arrayBuffer);
            currentPdfDoc = await pdfjsLib.getDocument({ data: typedArray }).promise;
            currentPdfTotalPages = currentPdfDoc.numPages;
            await renderPdfPage(1);
            bindScrollSave();
            await loadProgressForCurrent();
            showLoading(false);
        } catch (e) {
            showLoading(false);
            readerArea.innerHTML = `<div class="empty-state">PDF加载失败</div>`;
        }
    }

    async function renderPdfPage(pageNumber, isJump = false) {
        if (!currentPdfDoc) return;
        currentPdfPageNum = Math.min(Math.max(1, pageNumber), currentPdfTotalPages);
        readerArea.innerHTML = `<div class="pdf-viewer" id="pdfViewer"></div>`;
        const container = document.getElementById('pdfViewer');
        for (let i = 1; i <= currentPdfTotalPages; i++) {
            const page = await currentPdfDoc.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            canvas.className = 'pdf-page-canvas';
            canvas.setAttribute('data-page-num', i);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            container.appendChild(canvas);
        }
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    const p = parseInt(e.target.dataset.pageNum);
                    if (!isNaN(p)) {
                        currentPdfPageNum = p;
                        saveProgress();
                    }
                }
            });
        }, { threshold: 0.5 });
        document.querySelectorAll('.pdf-page-canvas').forEach(canvas => observer.observe(canvas));
        if (isJump) {
            document.querySelector(`.pdf-page-canvas[data-page-num='${currentPdfPageNum}']`)?.scrollIntoView({ behavior: 'smooth' });
        }
        buildPdfToc();
    }

    function buildPdfToc() {
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        for (let i = 1; i <= currentPdfTotalPages; i++) {
            const li = document.createElement('li');
            li.className = 'toc-item';
            li.innerText = `第 ${i} 页`;
            li.addEventListener('click', () => renderPdfPage(i, true));
            ul.appendChild(li);
        }
        tocListEl.appendChild(ul);
    }

    function clearReader() {
        if (currentRendition) try { currentRendition.destroy(); } catch (e) {}
        if (currentEpubBook) try { currentEpubBook.destroy(); } catch (e) {}
        currentPdfDoc = null;
        currentTxtRaw = null;
        currentTxtChunks = [];
        readerArea.innerHTML = '';
        currentBookType = null;
        tocListEl.innerHTML = '<li style="padding:20px;text-align:center;">暂无目录</li>';
        chapterNavBar.classList.remove('visible');
        chapterTitleSpan.innerText = '';
        clearSearch();
    }

    function bindScrollSave() {
        let saveTimer = null;
        const handler = () => { saveProgress(); };
        readerContainer.addEventListener('scroll', () => {
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(handler, 600);
        });
    }

    function setTheme(theme) {
        currentTheme = theme;
        if (theme === 'dark') document.body.classList.add('dark');
        else document.body.classList.remove('dark');
        if (currentBookType === 'epub' && currentRendition) currentRendition.themes.select(theme);
        if (currentBookType === 'txt') {
            const tv = document.querySelector('.txt-viewer');
            if (tv) tv.style.color = theme === 'dark' ? '#e2e8f0' : '#1e293b';
        }
        saveGlobalConfig();
    }

    function adjustFontSize(delta) {
        let newSize = currentFontSize + delta;
        if (newSize < 70) newSize = 70;
        if (newSize > 180) newSize = 180;
        currentFontSize = newSize;
        if (currentBookType === 'epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize + "%");
        if (currentBookType === 'txt') {
            const tv = document.querySelector('.txt-viewer');
            if (tv) tv.style.fontSize = (currentFontSize / 100) * 1.1 + "rem";
        }
        saveGlobalConfig();
    }

    // ================== 文件处理 ==================
    async function processFile(file, isCloud = false) {
        if (!file) return;
        const name = file.name, ext = name.split('.').pop().toLowerCase();
        const buffer = await file.arrayBuffer();
        if (!isCloud) {
            const fileId = `file_${name}_${Date.now()}`;
            currentBookUrlOrId = fileId;
            await saveBookToIndexedDB(fileId, new Blob([buffer]), name, ext);
        } else {
            currentBookUrlOrId = '';
        }
        clearSearch();
        if (ext === 'epub') await loadEpub(buffer, name);
        else if (ext === 'pdf') await loadPdf(buffer, name);
        else if (ext === 'txt') await loadTxtSmartOrPlain(buffer, name);
        else alert("不支持格式");
        if (!isCloud) saveGlobalConfig();
    }

    async function loadFromUrl(url) {
        if (!url.trim()) return;
        showLoading(true, "获取远程文件...");
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const ext = url.split('.').pop().split('?')[0].toLowerCase();
            const filename = url.split('/').pop() || "book";
            const file = new File([blob], filename, { type: blob.type });
            currentBookUrlOrId = url;
            await processFile(file);
            urlPanel.style.display = 'none';
        } catch (err) {
            alert("加载失败:" + err.message);
        } finally {
            showLoading(false);
        }
    }

    // ================== 全文搜索 ==================
    function clearSearch() {
        currentSearchTerm = "";
        currentSearchMatches = [];
        searchInput.value = "";
        searchDropdown.style.display = "none";
        clearSearchBtn.style.display = "none";
        removeHighlights();
        localMatchList.innerHTML = "";
        globalMatchList.innerHTML = "";
    }

    function performSearch(query) {
        currentSearchTerm = query;
        if (!query.trim()) {
            searchDropdown.style.display = "none";
            clearSearchBtn.style.display = "none";
            removeHighlights();
            return;
        }
        clearSearchBtn.style.display = "inline-flex";
        const lowerQuery = query.toLowerCase();

        // 本页搜索
        const localText = getCurrentVisibleText();
        const localMatches = [];
        let idx = localText.toLowerCase().indexOf(lowerQuery);
        while (idx !== -1) {
            const start = Math.max(0, idx - 30);
            const end = Math.min(localText.length, idx + query.length + 30);
            localMatches.push({
                start: idx,
                end: idx + query.length,
                text: localText.slice(start, end).replace(/\n/g, ' ')
            });
            idx = localText.toLowerCase().indexOf(lowerQuery, idx + 1);
        }
        currentSearchMatches = localMatches;
        localMatchList.innerHTML = localMatches.length
            ? localMatches.map(m => `<li>...${escapeHtml(m.text)}...</li>`).join('')
            : '<li>无匹配</li>';

        // 全文搜索
        if (currentBookType === 'epub' && currentRendition) {
            currentRendition.search(query).then(results => {
                if (results && results.length) {
                    globalMatchList.innerHTML = results.map(r => `<li data-cfi="${r.cfi}">${escapeHtml(r.excerpt)}</li>`).join('');
                } else {
                    globalMatchList.innerHTML = '<li>全文无匹配</li>';
                }
            }).catch(() => globalMatchList.innerHTML = '<li>全文搜索失败</li>');
        } else {
            const globalResults = searchGlobal(query);
            globalMatchList.innerHTML = globalResults.length
                ? globalResults.map(r => {
                    if (r.chapterIndex !== undefined) {
                        return `<li data-chapter-index="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count}处)</li>`;
                    } else {
                        return `<li>${escapeHtml(r.title)} (${r.count}处)</li>`;
                    }
                }).join('')
                : '<li>全文无匹配</li>';
        }

        searchDropdown.style.display = "block";
        highlightLocalMatches();
    }

    function getCurrentVisibleText() {
        if (currentBookType === 'txt') {
            if (smartChapterMode && currentTxtChunks.length) {
                return currentTxtChunks[currentChapterIndex].content;
            } else {
                return currentTxtRaw || "";
            }
        } else if (currentBookType === 'epub') {
            return readerArea.innerText || "";
        } else if (currentBookType === 'pdf') {
            return readerArea.innerText || "";
        }
        return "";
    }

    function searchGlobal(query) {
        if (!query) return [];
        const lowerQuery = query.toLowerCase();
        const results = [];
        if (currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, idx) => {
                const count = (ch.content.toLowerCase().split(lowerQuery).length - 1);
                if (count > 0) results.push({ chapterIndex: idx, title: ch.title, count });
            });
        } else if (currentBookType === 'txt') {
            const count = (currentTxtRaw || "").toLowerCase().split(lowerQuery).length - 1;
            if (count > 0) results.push({ title: "全文", count });
        }
        return results;
    }

    function highlightLocalMatches() {
        removeHighlights();
        if (!currentSearchTerm || currentSearchMatches.length === 0) return;
        const container = getTextViewContainer();
        if (!container) return;
        const regex = new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi');
        container.innerHTML = container.innerHTML.replace(regex, '<mark>$1</mark>');
    }

    function removeHighlights() {
        const container = getTextViewContainer();
        if (!container) return;
        container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, '');
    }

    function getTextViewContainer() {
        if (currentBookType === 'txt') {
            return document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer');
        }
        return null;
    }

    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 搜索结果点击事件
    localMatchList.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li || !currentSearchMatches.length) return;
        const index = Array.from(localMatchList.children).indexOf(li);
        const match = currentSearchMatches[index];
        if (!match) return;
        const container = getTextViewContainer();
        if (container) {
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
            let node, offset = 0;
            while ((node = walker.nextNode())) {
                const len = node.textContent.length;
                if (offset + len > match.start) {
                    const range = document.createRange();
                    range.setStart(node, match.start - offset);
                    range.setEnd(node, match.end - offset);
                    range.startContainer.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    break;
                }
                offset += len;
            }
        }
    });

    globalMatchList.addEventListener('click', async (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        if (currentBookType === 'epub') {
            const cfi = li.dataset.cfi;
            if (cfi && currentRendition) {
                await currentRendition.display(cfi);
                setTimeout(() => performSearch(currentSearchTerm), 300);
            }
        } else if (currentBookType === 'txt') {
            const chapterIdx = parseInt(li.dataset.chapterIndex, 10);
            if (!isNaN(chapterIdx) && currentTxtChunks.length) {
                if (chapterIdx !== currentChapterIndex) {
                    await renderTxtChapter(chapterIdx);
                    setTimeout(() => performSearch(currentSearchTerm), 300);
                }
            }
        }
    });

    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        const query = searchInput.value;
        searchDebounceTimer = setTimeout(() => performSearch(query), 300);
    });

    clearSearchBtn.addEventListener('click', clearSearch);
    document.addEventListener('click', (e) => {
        if (!searchBar.contains(e.target)) {
            searchDropdown.style.display = 'none';
        }
    });

    // ================== 章节导航悬浮 ==================
    let navHideTimer = null;
    function showChapterNav() {
        chapterNavBar.classList.add('visible');
        clearTimeout(navHideTimer);
    }
    function hideChapterNav() {
        navHideTimer = setTimeout(() => {
            chapterNavBar.classList.remove('visible');
        }, 800);
    }

    readerContainer.addEventListener('mousemove', (e) => {
        const rect = readerContainer.getBoundingClientRect();
        const distanceToBottom = rect.bottom - e.clientY;
        if (distanceToBottom < 80) {
            showChapterNav();
        } else {
            hideChapterNav();
        }
    });
    readerContainer.addEventListener('mouseleave', hideChapterNav);
    chapterNavBar.addEventListener('mouseenter', () => {
        clearTimeout(navHideTimer);
        chapterNavBar.classList.add('visible');
    });
    chapterNavBar.addEventListener('mouseleave', hideChapterNav);

    // ================== URL 面板 ==================
    urlLoadBtn.addEventListener('click', () => {
        urlPanel.style.display = urlPanel.style.display === 'none' ? 'flex' : 'none';
        if (urlPanel.style.display === 'flex') bookUrlInput.focus();
    });
    closeUrlPanelBtn.addEventListener('click', () => urlPanel.style.display = 'none');
    loadUrlBtn.addEventListener('click', () => loadFromUrl(bookUrlInput.value));

    // ================== 文件输入事件（含云端上传询问）==================
    fileInput.addEventListener('change', async e => {
        if (e.target.files.length) {
            const file = e.target.files[0];
            await processFile(file);
            if (currentUser) {
                if (confirm('是否将此书上传到云端私人书库？')) {
                    const makePublic = confirm('是否同时公开此图书？');
                    await uploadToCloud(file, makePublic);
                }
            }
            fileInput.value = '';
        }
    });

    // 拖拽上传
    function initDragAndDrop() {
        document.body.addEventListener('dragover', e => e.preventDefault());
        document.body.addEventListener('drop', async e => {
            e.preventDefault();
            const f = e.dataTransfer.files;
            if (f.length) {
                const file = f[0];
                await processFile(file);
                if (currentUser) {
                    if (confirm('将此书上传到云端私人书库？')) {
                        const makePublic = confirm('是否同时公开？');
                        await uploadToCloud(file, makePublic);
                    }
                }
            }
        });
    }
    initDragAndDrop();

    // ================== 其他事件绑定 ==================
    toggleSidebarBtn.addEventListener('click', () => {
        isSidebarVisible = !isSidebarVisible;
        sidebar.classList.toggle('hide', !isSidebarVisible);
    });
    themeToggleBtn.addEventListener('click', () => setTheme(currentTheme === 'light' ? 'dark' : 'light'));
    fontPlusBtn.addEventListener('click', () => adjustFontSize(10));
    fontMinusBtn.addEventListener('click', () => adjustFontSize(-10));
    smartChapterBtn.addEventListener('click', () => {
        if (currentBookType === 'txt') toggleSmartChapterMode();
    });
    prevChapterBtn.addEventListener('click', () => {
        if (smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex - 1);
    });
    nextChapterBtn.addEventListener('click', () => {
        if (smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex + 1);
    });
    window.addEventListener('beforeunload', () => saveProgress());

    // ================== Supabase 认证相关 ==================
    function initSupabase() {
        if (!window.supabase) {
            alert('Supabase SDK 加载失败，请刷新');
            return;
        }
        // ✅ 用 createClient 的返回值覆盖 supabase 变量
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    function updateAuthUI() {
        if (!userArea) return;
        if (currentUser) {
            userArea.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:0.8rem;">${escapeHtml(currentUser.email)}</span>
                    <button id="logoutBtn" class="btn-icon"><i class="fas fa-sign-out-alt"></i></button>
                </div>`;
            document.getElementById('logoutBtn').addEventListener('click', async () => {
                await supabase.auth.signOut();
                currentUser = null;
                updateAuthUI();
            });
            myLibraryBtn.style.display = 'inline-flex';
        } else {
            userArea.innerHTML = `<button id="authBtn" class="btn-icon"><i class="fas fa-user"></i> 登录</button>`;
            document.getElementById('authBtn').addEventListener('click', showAuthDialog);
            myLibraryBtn.style.display = 'none';
        }
    }

    // 认证弹窗
    function showAuthDialog() {
        authModal.style.display = 'flex';
        document.getElementById('authEmail').value = '';
        document.getElementById('authPassword').value = '';
        document.getElementById('authMsg').textContent = '';
        updateAuthModalMode();
    }

    function updateAuthModalMode() {
        const title = document.getElementById('authModalTitle');
        const submitBtn = document.getElementById('authSubmitBtn');
        const switchBtn = document.getElementById('authSwitchBtn');
        if (authMode === 'login') {
            title.textContent = '登录';
            submitBtn.textContent = '登录';
            switchBtn.textContent = '没有账号？去注册';
        } else {
            title.textContent = '注册';
            submitBtn.textContent = '注册';
            switchBtn.textContent = '已有账号？去登录';
        }
    }

    document.getElementById('authSwitchBtn').addEventListener('click', () => {
        authMode = authMode === 'login' ? 'signup' : 'login';
        updateAuthModalMode();
    });

    document.getElementById('authCloseBtn').addEventListener('click', () => {
        authModal.style.display = 'none';
    });

    document.getElementById('authSubmitBtn').addEventListener('click', async () => {
        const email = document.getElementById('authEmail').value;
        const password = document.getElementById('authPassword').value;
        const msgEl = document.getElementById('authMsg');
        if (!email || !password || password.length < 6) {
            msgEl.textContent = '邮箱和密码（至少6位）必填';
            return;
        }
        if (authMode === 'signup') {
            const { error } = await supabase.auth.signUp({ email, password });
            if (error) msgEl.textContent = '注册失败: ' + error.message;
            else {
                alert('注册成功！请查收验证邮件（如果已启用）。');
                authModal.style.display = 'none';
            }
        } else {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) msgEl.textContent = '登录失败: ' + error.message;
            else {
                currentUser = data.user;
                updateAuthUI();
                authModal.style.display = 'none';
                // 尝试加载云端进度
                loadCloudProgressIfNeeded();
            }
        }
    });

    async function initAuth() {
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        currentUser = session?.user || null;
        updateAuthUI();
        supabase.auth.onAuthStateChange((event, session) => {
            currentUser = session?.user || null;
            updateAuthUI();
            // 若刚登录且无正在阅读的书，尝试恢复云端进度
            if (currentUser && !currentFileName) {
                loadCloudProgressIfNeeded();
            }
        });
    }

    // ================== 云端书库 ==================
    async function fetchCloudBooks(filter = 'all', search = '') {
        let query = supabase.from('books').select('*');
        if (filter === 'official') query = query.eq('is_official', true);
        else if (filter === 'public') query = query.eq('is_public', true).eq('is_official', false);
        else query = query.or('is_official.eq.true,is_public.eq.true');
        if (search) query = query.ilike('title', `%${search}%`);
        const { data, error } = await query;
        if (error) {
            console.error('获取云端图书失败', error);
            return [];
        }
        return data;
    }

    async function renderCloudPanel() {
        const filter = document.getElementById('cloudTypeFilter').value;
        const search = document.getElementById('cloudSearchInput').value;
        const books = await fetchCloudBooks(filter, search);
        const list = document.getElementById('cloudBookList');
        list.innerHTML = '';
        if (books.length === 0) {
            list.innerHTML = '<li style="padding:12px;text-align:center;">暂无图书</li>';
            return;
        }
        books.forEach(book => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div>
                    <strong>${escapeHtml(book.title)}</strong>
                    <span style="font-size:0.8rem;color:gray;">${book.is_official ? '官方' : '用户公开'}</span>
                </div>
                <div class="actions">
                    <button class="read-cloud-btn" data-id="${book.id}">阅读</button>
                    ${currentUser && (book.uploader_id === currentUser.id || currentUser.app_metadata?.role === 'admin') ? 
                        `<button class="delete-cloud-btn" data-id="${book.id}">删除</button>` : ''}
                </div>`;
            list.appendChild(li);
        });
        document.querySelectorAll('.read-cloud-btn').forEach(btn => {
            btn.addEventListener('click', () => loadCloudBook(btn.dataset.id));
        });
        document.querySelectorAll('.delete-cloud-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteCloudBook(btn.dataset.id));
        });
    }

    async function loadCloudBook(bookId) {
        if (!currentUser) {
            alert('请先登录再阅读云端图书');
            return;
        }
        showLoading(true, '加载云端图书...');
        const { data: book, error } = await supabase.from('books').select('*').eq('id', bookId).single();
        if (error || !book) {
            alert('图书信息获取失败');
            showLoading(false);
            return;
        }
        const { data: signedData, error: signedError } = await supabase.storage
            .from('book-files')
            .createSignedUrl(book.file_path, 3600);
        if (signedError || !signedData) {
            alert('无法获取文件访问链接');
            showLoading(false);
            return;
        }
        const url = signedData.signedUrl;
        currentCloudBookId = bookId;
        currentFileName = `cloud_${bookId}`;
        try {
            const resp = await fetch(url);
            const blob = await resp.blob();
            const file = new File([blob], book.title, { type: `application/${book.file_type}` });
            await processFile(file, true);
            cloudPanel.style.display = 'none';
        } catch (e) {
            alert('加载失败: ' + e.message);
        } finally {
            showLoading(false);
        }
    }

    async function deleteCloudBook(bookId) {
        if (!confirm('确定要删除这本云图书吗？')) return;
        const { data: book } = await supabase.from('books').select('file_path').eq('id', bookId).single();
        if (book && book.file_path) {
            await supabase.storage.from('book-files').remove([book.file_path]);
        }
        await supabase.from('books').delete().eq('id', bookId);
        renderCloudPanel();
    }

    async function uploadToCloud(file, makePublic) {
        if (!currentUser) return;
        const { data: profile, error: profileErr } = await supabase
            .from('profiles').select('storage_used').eq('id', currentUser.id).single();
        const used = profile?.storage_used || 0;
        if (used + file.size > 64 * 1024 * 1024) {
            alert('私人书库空间不足（上限64MB），请清理后重试');
            return;
        }
        showLoading(true, '上传中...');
        // 提取扩展名（统一小写）
        const fileExt = file.name.split('.').pop().toLowerCase();
        // 生成纯 ASCII 文件名，避免中文字符导致存储 400 错误
        const asciiFileName = `${Date.now()}.${fileExt}`;
        const filePath = `user-uploads/${currentUser.id}/${asciiFileName}`;

        const { error: uploadError } = await supabase.storage
            .from('book-files')
            .upload(filePath, file);
        if (uploadError) {
            alert('上传失败: ' + uploadError.message);
            showLoading(false);
            return;
        }
        // 书名的处理：使用原始文件名（去掉扩展名）作为标题，可保留中文
        const bookTitle = file.name.replace(/\.[^.]+$/, '');
        const { data: bookRecord, error: insertError } = await supabase.from('books').insert({
            title: bookTitle,
            file_path: filePath,
            file_type: fileExt,
            file_size: file.size,
            uploader_id: currentUser.id,
            is_public: makePublic
        }).select().single();
        if (insertError) {
            await supabase.storage.from('book-files').remove([filePath]);
            alert('创建图书记录失败: ' + insertError.message);
        } else {
            await supabase.from('profiles').update({ storage_used: used + file.size }).eq('id', currentUser.id);
            alert('上传成功！');
        }
        showLoading(false);
    }

    // 我的书库
    async function fetchMyBooks() {
        const { data, error } = await supabase.from('books').select('*').eq('uploader_id', currentUser.id);
        if (error) return [];
        return data;
    }

    async function renderMyLibrary() {
        const books = await fetchMyBooks();
        const list = document.getElementById('myBookList');
        const { data: profile } = await supabase.from('profiles').select('storage_used').eq('id', currentUser.id).single();
        const usedMB = ((profile?.storage_used || 0) / 1024 / 1024).toFixed(2);
        document.getElementById('storageUsed').textContent = usedMB + ' MB';
        list.innerHTML = '';
        books.forEach(book => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div>${escapeHtml(book.title)} (${book.file_type})</div>
                <div class="actions">
                    <button class="read-my-book" data-id="${book.id}">阅读</button>
                    <button class="download-my-book" data-id="${book.id}">下载</button>
                    <button class="delete-my-book" data-id="${book.id}">删除</button>
                </div>`;
            list.appendChild(li);
        });
        document.querySelectorAll('.read-my-book').forEach(b => b.addEventListener('click', () => loadCloudBook(b.dataset.id)));
        document.querySelectorAll('.download-my-book').forEach(b => b.addEventListener('click', async () => {
            const { data: book } = await supabase.from('books').select('*').eq('id', b.dataset.id).single();
            if (!book) return;
            const { data: signed } = await supabase.storage.from('book-files').createSignedUrl(book.file_path, 60);
            if (signed) window.open(signed.signedUrl, '_blank');
        }));
        document.querySelectorAll('.delete-my-book').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('删除后无法恢复，确定吗？')) return;
            const { data: book } = await supabase.from('books').select('*').eq('id', b.dataset.id).single();
            if (book) {
                await supabase.storage.from('book-files').remove([book.file_path]);
                await supabase.from('books').delete().eq('id', book.id);
                const { data: profile } = await supabase.from('profiles').select('storage_used').eq('id', currentUser.id).single();
                const newUsed = (profile?.storage_used || 0) - book.file_size;
                await supabase.from('profiles').update({ storage_used: Math.max(0, newUsed) }).eq('id', currentUser.id);
            }
            renderMyLibrary();
        }));
    }

    // ================== 云端面板/书库按钮事件 ==================
    cloudLibraryBtn.addEventListener('click', () => {
        cloudPanel.style.display = 'flex';
        renderCloudPanel();
    });
    document.getElementById('closeCloudPanelBtn').addEventListener('click', () => cloudPanel.style.display = 'none');
    document.getElementById('cloudTypeFilter').addEventListener('change', renderCloudPanel);
    document.getElementById('cloudSearchInput').addEventListener('input', renderCloudPanel);

    myLibraryBtn.addEventListener('click', async () => {
        myLibraryPanel.style.display = 'flex';
        await renderMyLibrary();
    });
    document.getElementById('closeMyLibraryBtn').addEventListener('click', () => myLibraryPanel.style.display = 'none');

    // ================== 启动加载 ==================
    loadGlobalConfig();
    initSupabase();
    initAuth();

    (async () => {
        const cfg = loadGlobalConfig();
        if (cfg.lastBookId) {
            const bookRecord = await loadBookFromIndexedDB(cfg.lastBookId);
            if (bookRecord && bookRecord.blob) {
                const file = new File([bookRecord.blob], bookRecord.fileName, { type: `application/${bookRecord.fileType}` });
                await processFile(file);
            }
        }
        // 登录后尝试云端进度恢复（无本地书时）
        if (currentUser && !currentFileName) {
            loadCloudProgressIfNeeded();
        }
    })();

    window.processFile = processFile;
})();
