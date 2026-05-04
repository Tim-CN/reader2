(function(){
    // ---------- 全局变量 ----------
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

    // IndexedDB
    let db = null;
    const DB_NAME = "ZZXReaderDB";
    const STORE_NAME = "books";

    // 搜索相关
    let currentSearchTerm = "";
    let currentSearchMatches = [];
    let searchDebounceTimer = null;

    // DOM元素
    const fileInput = document.getElementById('fileInput');
    const bookUrlInput = document.getElementById('bookUrl');
    const loadUrlBtn = document.getElementById('loadUrlBtn');
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
    const toolbar = document.getElementById('toolbar');
    const tapLeft = document.getElementById('tapLeft');
    const tapCenter = document.getElementById('tapCenter');
    const tapRight = document.getElementById('tapRight');
    const searchBar = document.querySelector('.search-bar');

    function showLoading(show, text="加载中...") {
        loadingToast.style.display = show ? "block" : "none";
        if(show) loadingToast.innerText = text;
    }

    // IndexedDB
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { db = request.result; resolve(db); };
            request.onupgradeneeded = (e) => {
                const dbRef = e.target.result;
                if(!dbRef.objectStoreNames.contains(STORE_NAME)) dbRef.createObjectStore(STORE_NAME, { keyPath: "id" });
            };
        });
    }

    async function saveBookToIndexedDB(id, blob, name, type) {
        if(!db) await initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const req = store.put({ id, blob, fileName: name, fileType: type, timestamp: Date.now() });
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
    }

    async function loadBookFromIndexedDB(id) {
        if(!db) await initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function saveGlobalConfig() {
        localStorage.setItem("zzx_reader_config", JSON.stringify({
            fontSize: currentFontSize, theme: currentTheme,
            lastBookId: currentBookUrlOrId, lastBookType: currentBookType,
            lastFileName: currentFileName, smartChapterMode
        }));
    }

    function loadGlobalConfig() {
        const raw = localStorage.getItem("zzx_reader_config");
        if(raw) {
            try {
                const cfg = JSON.parse(raw);
                currentFontSize = cfg.fontSize || 100;
                currentTheme = cfg.theme || "light";
                smartChapterMode = cfg.smartChapterMode || false;
                setTheme(currentTheme);
                adjustFontSize(0);
                return cfg;
            } catch(e) {}
        }
        return {};
    }

    async function saveProgress() {
        if(!currentFileName) return;
        const key = `progress_${currentFileName}`;
        let data = { type: currentBookType, smartMode: smartChapterMode };
        if(currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                if(loc && loc.start && loc.start.cfi) data.cfi = loc.start.cfi;
            } catch(e) {}
        } else if(currentBookType === 'pdf') {
            data.page = currentPdfPageNum;
        } else if(currentBookType === 'txt') {
            if(smartChapterMode) data.smartChapterIndex = currentChapterIndex;
            else {
                const ratio = readerContainer.scrollTop / (readerArea.scrollHeight - readerContainer.clientHeight);
                data.scrollRatio = isNaN(ratio) ? 0 : ratio;
            }
        }
        localStorage.setItem(key, JSON.stringify(data));
        saveGlobalConfig();
    }

    async function loadProgressForCurrent() {
        if(!currentFileName) return;
        const raw = localStorage.getItem(`progress_${currentFileName}`);
        if(!raw) return;
        try {
            const data = JSON.parse(raw);
            if(data.type === 'epub' && currentBookType === 'epub' && data.cfi) {
                await currentRendition.display(data.cfi);
            } else if(data.type === 'pdf' && currentBookType === 'pdf' && data.page) {
                await renderPdfPage(data.page, true);
            } else if(data.type === 'txt' && currentBookType === 'txt') {
                if(data.smartMode) smartChapterMode = data.smartMode;
                updateSmartChapterUI();
                if(smartChapterMode && currentTxtChunks.length) {
                    let idx = data.smartChapterIndex || 0;
                    if(idx >= currentTxtChunks.length) idx = 0;
                    await renderTxtChapter(idx);
                } else if(!smartChapterMode) {
                    await renderFullTxtLazy();
                    setTimeout(() => {
                        const total = readerArea.scrollHeight - readerContainer.clientHeight;
                        readerContainer.scrollTop = total * (data.scrollRatio || 0);
                    }, 100);
                }
            }
        } catch(e) {}
    }

    async function detectEncoding(buffer) {
        const encodings = ['utf-8', 'gbk', 'gb2312', 'big5', 'shift-jis', 'euc-kr'];
        const sample = buffer.slice(0, 4096);
        function scoreText(text) {
            let valid = 0;
            for(let i=0; i<text.length && i<1000; i++) {
                const code = text.charCodeAt(i);
                if((code>=0x4E00 && code<=0x9FFF) || (code>=0x3040 && code<=0x30FF) || (code>=0xAC00 && code<=0xD7AF) || (code>=0x20 && code<=0x7E) || code===0x0A||code===0x0D||code===0x09) valid++;
            }
            return valid / (text.length || 1);
        }
        let bestEnc = 'utf-8', bestScore = 0;
        for(const enc of encodings) {
            try {
                const t = new TextDecoder(enc, {fatal:false}).decode(sample);
                const s = scoreText(t);
                if(s > bestScore) { bestScore = s; bestEnc = enc; }
                if(bestScore > 0.95) break;
            } catch(e) {}
        }
        return bestEnc;
    }

    function splitIntelligentChapters(text) {
        const unitCounter = {};
        const pat = /^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])/gm;
        let m;
        while((m=pat.exec(text))!==null) unitCounter[m[2]] = (unitCounter[m[2]]||0)+1;
        let bestUnit = null, maxCount = 0;
        for(const u in unitCounter) if(unitCounter[u] > maxCount) { maxCount = unitCounter[u]; bestUnit = u; }
        const splitPat = bestUnit ? new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`,'gm') : /^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        const lines = text.split(/\r?\n/);
        const chapters = [];
        let curTitle = "序言", curContent = [];
        for(const line of lines) {
            const t = line.trim();
            splitPat.lastIndex = 0;
            if(splitPat.test(t) && t.length < 50) {
                if(curContent.length) chapters.push({title:curTitle, content:curContent.join('\n')});
                curTitle = t; curContent = [];
            } else curContent.push(line);
        }
        if(curContent.length) chapters.push({title:curTitle, content:curContent.join('\n')});
        return chapters.length ? chapters : [{title:"全文", content:text}];
    }

    async function renderTxtChapter(index) {
        if(!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(Math.max(0, index), currentTxtChunks.length-1);
        const ch = currentTxtChunks[currentChapterIndex];
        readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"><h3>${escapeHtml(ch.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(ch.content)}</div></div>`;
        updateTocForSmartChapters();
        chapterTitleSpan.innerText = ch.title;
        chapterNavBar.classList.remove('visible');
        readerContainer.scrollTop = 0;
        if(currentSearchTerm) performSearch(currentSearchTerm);
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if(!smartChapterMode || !currentTxtChunks.length) return;
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul'); ul.className = 'toc-list';
        currentTxtChunks.forEach((ch, idx) => {
            const li = document.createElement('li'); li.className = 'toc-item';
            if(idx === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length>30 ? ch.title.slice(0,28)+'...' : ch.title;
            li.addEventListener('click', ()=>renderTxtChapter(idx));
            ul.appendChild(li);
        });
        tocListEl.appendChild(ul);
    }

    async function renderFullTxtLazy() {
        if(!currentTxtRaw) return;
        readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"></div>`;
        const container = readerArea.querySelector('.txt-viewer');
        let index = 0;
        function renderNext() {
            const next = currentTxtRaw.slice(index, index+50000);
            if(next) {
                container.appendChild(document.createTextNode(next));
                index += 50000;
                requestAnimationFrame(() => { if(index < currentTxtRaw.length) renderNext(); else { if(currentSearchTerm) performSearch(currentSearchTerm); saveProgress(); } });
            } else saveProgress();
        }
        renderNext();
        chapterTitleSpan.innerText = currentFileName;
    }

    function escapeHtml(s) {
        return s.replace(/[&<>]/g, c => c==='&'?'&amp;':c==='<'?'&lt;':'&gt;');
    }

    async function loadTxtSmartOrPlain(buffer, filename) {
        clearReader();
        currentBookType = 'txt'; currentFileName = filename;
        const enc = await detectEncoding(buffer);
        currentTxtRaw = new TextDecoder(enc).decode(buffer);
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        const saved = localStorage.getItem(`txt_smart_mode_${filename}`);
        if(saved !== null) smartChapterMode = saved === 'true';
        updateSmartChapterUI();
        if(smartChapterMode && currentTxtChunks.length) {
            await renderTxtChapter(0);
        } else {
            await renderFullTxtLazy();
            buildTxtSimpleToc();
        }
        bindScrollSave();
        await loadProgressForCurrent();
        if(currentSearchTerm) performSearch(currentSearchTerm);
    }

    function buildTxtSimpleToc() {
        tocListEl.innerHTML = '<li class="toc-item">纯文本模式</li><li class="toc-item" style="color:#3b82f6" id="enableSmartBtnToc">开启智能章节</li>';
        document.getElementById('enableSmartBtnToc')?.addEventListener('click', ()=>toggleSmartChapterMode(true));
    }

    function toggleSmartChapterMode(force) {
        if(currentBookType !== 'txt') return;
        smartChapterMode = force !== undefined ? force : !smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        updateSmartChapterUI();
        if(smartChapterMode) renderTxtChapter(currentChapterIndex);
        else { renderFullTxtLazy(); buildTxtSimpleToc(); }
        saveProgress();
    }

    function updateSmartChapterUI() {
        smartChapterBtn.classList.toggle('smart-active', currentBookType==='txt' && smartChapterMode);
    }

    async function loadEpub(buffer, filename) {
        clearReader(); currentBookType='epub'; currentFileName=filename; showLoading(true);
        try {
            const blob = new Blob([buffer], {type:"application/epub+zip"});
            currentEpubBook = ePub(URL.createObjectURL(blob));
            currentRendition = currentEpubBook.renderTo("readerArea", {width:"100%", height:"100%", spread:"none", flow:"paginated"});
            await currentRendition.display();
            currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
            currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
            setTheme(currentTheme);
            currentRendition.themes.fontSize(currentFontSize+"%");
            const nav = await currentEpubBook.loaded.navigation;
            buildEpubToc(nav.toc);
            currentRendition.on('relocated', saveProgress);
            await loadProgressForCurrent();
            showLoading(false);
        } catch(e) { showLoading(false); readerArea.innerHTML = '<div class="empty-state">EPUB加载失败</div>'; }
    }

    function buildEpubToc(toc) {
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        const renderItems = (items, parent) => items.forEach(item => {
            const li = document.createElement('li'); li.className = 'toc-item';
            li.innerText = item.label || '章节';
            if(item.href) li.addEventListener('click', ()=>currentRendition.display(item.href));
            parent.appendChild(li);
            if(item.subitems) renderItems(item.subitems, parent);
        });
        renderItems(toc, ul);
        tocListEl.appendChild(ul);
    }

    async function loadPdf(buffer, filename) {
        clearReader(); currentBookType='pdf'; currentFileName=filename; showLoading(true);
        try {
            currentPdfDoc = await pdfjsLib.getDocument({data: new Uint8Array(buffer)}).promise;
            currentPdfTotalPages = currentPdfDoc.numPages;
            await renderPdfPage(1);
            bindScrollSave();
            await loadProgressForCurrent();
            showLoading(false);
        } catch(e) { showLoading(false); readerArea.innerHTML = '<div class="empty-state">PDF加载失败</div>'; }
    }

    async function renderPdfPage(pageNum, isJump=false) {
        if(!currentPdfDoc) return;
        currentPdfPageNum = Math.min(Math.max(1, pageNum), currentPdfTotalPages);
        readerArea.innerHTML = '<div class="pdf-viewer" id="pdfViewer"></div>';
        const container = document.getElementById('pdfViewer');
        for(let i=1; i<=currentPdfTotalPages; i++) {
            const page = await currentPdfDoc.getPage(i);
            const vp = page.getViewport({scale:1.5});
            const canvas = document.createElement('canvas'); canvas.height = vp.height; canvas.width = vp.width;
            canvas.className = 'pdf-page-canvas'; canvas.dataset.pageNum = i;
            await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
            container.appendChild(canvas);
        }
        new IntersectionObserver((entries) => {
            entries.forEach(e => { if(e.isIntersecting) { const p = parseInt(e.target.dataset.pageNum); if(!isNaN(p)) { currentPdfPageNum = p; saveProgress(); } } });
        }, {threshold:0.5}).observe(document.querySelector(`.pdf-page-canvas[data-page-num='${currentPdfPageNum}']`));
        if(isJump) document.querySelector(`.pdf-page-canvas[data-page-num='${currentPdfPageNum}']`)?.scrollIntoView({behavior:'smooth'});
        buildPdfToc();
        chapterTitleSpan.innerText = `第 ${currentPdfPageNum} 页`;
    }

    function buildPdfToc() {
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        for(let i=1; i<=currentPdfTotalPages; i++) {
            const li = document.createElement('li'); li.className = 'toc-item';
            li.innerText = `第 ${i} 页`;
            li.addEventListener('click', ()=>renderPdfPage(i, true));
            ul.appendChild(li);
        }
        tocListEl.appendChild(ul);
    }

    function clearReader() {
        if(currentRendition) try{currentRendition.destroy()}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy()}catch(e){}
        currentPdfDoc = null; currentTxtRaw = null; currentTxtChunks = [];
        readerArea.innerHTML = ''; currentBookType = null;
        tocListEl.innerHTML = '<li style="padding:20px;text-align:center;">暂无目录</li>';
        chapterNavBar.classList.remove('visible');
        clearSearch();
    }

    function bindScrollSave() {
        let timer;
        readerContainer.addEventListener('scroll', () => {
            clearTimeout(timer);
            timer = setTimeout(saveProgress, 600);
        }, {passive: true});
    }

    function setTheme(theme) {
        currentTheme = theme;
        document.body.classList.toggle('dark', theme==='dark');
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.select(theme);
        if(currentBookType==='txt') {
            const tv = document.querySelector('.txt-viewer');
            if(tv) tv.style.color = theme==='dark'?'#e2e8f0':'#1e293b';
        }
        saveGlobalConfig();
    }

    function adjustFontSize(delta) {
        currentFontSize = Math.min(180, Math.max(70, currentFontSize + delta));
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize+"%");
        if(currentBookType==='txt') {
            const tv = document.querySelector('.txt-viewer');
            if(tv) tv.style.fontSize = (currentFontSize/100)*1.1 + "rem";
        }
        saveGlobalConfig();
    }

    async function processFile(file) {
        if(!file) return;
        const name = file.name, ext = name.split('.').pop().toLowerCase();
        const buffer = await file.arrayBuffer();
        currentBookUrlOrId = `file_${name}_${Date.now()}`;
        await saveBookToIndexedDB(currentBookUrlOrId, new Blob([buffer]), name, ext);
        clearSearch();
        if(ext==='epub') await loadEpub(buffer, name);
        else if(ext==='pdf') await loadPdf(buffer, name);
        else if(ext==='txt') await loadTxtSmartOrPlain(buffer, name);
        else alert("不支持格式");
        saveGlobalConfig();
    }

    async function loadFromUrl(url) {
        showLoading(true, "获取远程文件...");
        try {
            const resp = await fetch(url);
            if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const filename = url.split('/').pop() || "book";
            const ext = url.split('.').pop().split('?')[0].toLowerCase();
            await processFile(new File([blob], filename));
            urlPanel.style.display = 'none';
        } catch(e) { alert("加载失败："+e.message); }
        finally { showLoading(false); }
    }

    function initDragAndDrop() {
        document.body.addEventListener('dragover', e=>e.preventDefault());
        document.body.addEventListener('drop', async e=>{
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if(file) await processFile(file);
        });
    }

    // ========== 搜索功能 ==========
    function clearSearch() {
        currentSearchTerm = "";
        currentSearchMatches = [];
        searchInput.value = "";
        searchDropdown.style.display = "none";
        clearSearchBtn.style.display = "none";
        removeHighlights();
        localMatchList.innerHTML = globalMatchList.innerHTML = "";
    }

    function performSearch(query) {
        currentSearchTerm = query;
        if(!query.trim()) {
            searchDropdown.style.display = "none";
            clearSearchBtn.style.display = "none";
            removeHighlights();
            return;
        }
        clearSearchBtn.style.display = "inline-flex";
        const lower = query.toLowerCase();

        // 本页匹配
        const localText = getCurrentVisibleText();
        const localMatches = [];
        let idx = localText.toLowerCase().indexOf(lower);
        while(idx !== -1) {
            const start = Math.max(0, idx-30);
            const end = Math.min(localText.length, idx+query.length+30);
            localMatches.push({ start: idx, end: idx+query.length, text: localText.slice(start, end).replace(/\n/g, ' ') });
            idx = localText.toLowerCase().indexOf(lower, idx+1);
        }
        currentSearchMatches = localMatches;
        localMatchList.innerHTML = localMatches.length ? localMatches.map(m => `<li>...${escapeHtml(m.text)}...</li>`).join('') : '<li>无匹配</li>';

        // 全文匹配
        if(currentBookType === 'epub' && currentRendition) {
            currentRendition.search(query).then(results => {
                globalMatchList.innerHTML = results.length ? results.map(r => `<li data-cfi="${r.cfi}">${escapeHtml(r.excerpt||'')}</li>`).join('') : '<li>全文无匹配</li>';
            }).catch(() => globalMatchList.innerHTML = '<li>全文搜索失败</li>');
        } else {
            const globalResults = searchGlobal(query);
            globalMatchList.innerHTML = globalResults.length ? globalResults.map(r => {
                if(r.chapterIndex !== undefined) return `<li data-chapter-index="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count}处)</li>`;
                return `<li>${escapeHtml(r.title)} (${r.count}处)</li>`;
            }).join('') : '<li>全文无匹配</li>';
        }
        searchDropdown.style.display = "block";
        highlightLocalMatches();
    }

    function getCurrentVisibleText() {
        if(currentBookType === 'txt') {
            return smartChapterMode ? currentTxtChunks[currentChapterIndex]?.content || "" : currentTxtRaw || "";
        }
        return readerArea.innerText || "";
    }

    function searchGlobal(query) {
        const lower = query.toLowerCase();
        const results = [];
        if(currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, i) => {
                const count = (ch.content.toLowerCase().split(lower).length - 1);
                if(count > 0) results.push({ chapterIndex: i, title: ch.title, count });
            });
        } else if(currentBookType === 'txt') {
            const count = (currentTxtRaw||"").toLowerCase().split(lower).length - 1;
            if(count > 0) results.push({ title: "全文", count });
        }
        return results;
    }

    function highlightLocalMatches() {
        removeHighlights();
        if(!currentSearchTerm) return;
        const container = getTextViewContainer();
        if(!container) return;
        const regex = new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi');
        container.innerHTML = container.innerHTML.replace(regex, '<mark>$1</mark>');
    }

    function removeHighlights() {
        const container = getTextViewContainer();
        if(!container) return;
        container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, '');
    }

    function getTextViewContainer() {
        return document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer');
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 搜索结果点击事件
    localMatchList.addEventListener('click', e => {
        const li = e.target.closest('li');
        if(!li || !currentSearchMatches.length) return;
        const index = Array.from(localMatchList.children).indexOf(li);
        const match = currentSearchMatches[index];
        if(!match) return;
        const container = getTextViewContainer();
        if(container) {
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
            let node, offset = 0;
            while((node = walker.nextNode())) {
                const len = node.textContent.length;
                if(offset + len > match.start) {
                    const range = document.createRange();
                    range.setStart(node, match.start - offset);
                    range.setEnd(node, match.end - offset);
                    range.startContainer.parentElement.scrollIntoView({behavior:'smooth', block:'center'});
                    break;
                }
                offset += len;
            }
        }
    });

    globalMatchList.addEventListener('click', e => {
        const li = e.target.closest('li');
        if(!li) return;
        if(currentBookType === 'epub') {
            const cfi = li.dataset.cfi;
            if(cfi && currentRendition) currentRendition.display(cfi).then(() => setTimeout(()=>performSearch(currentSearchTerm), 300));
        } else if(currentBookType === 'txt') {
            const chapterIdx = parseInt(li.dataset.chapterIndex, 10);
            if(!isNaN(chapterIdx) && currentTxtChunks.length) {
                if(chapterIdx !== currentChapterIndex) renderTxtChapter(chapterIdx).then(() => setTimeout(()=>performSearch(currentSearchTerm), 300));
                else performSearch(currentSearchTerm);
            }
        }
    });

    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => performSearch(searchInput.value), 300);
    });
    clearSearchBtn.addEventListener('click', clearSearch);
    document.addEventListener('click', e => {
        if(!searchBar.contains(e.target)) searchDropdown.style.display = 'none';
    });

    // ========== 底部导航悬浮 ==========
    function isMobile() { return window.innerWidth <= 680; }
    function showChapterNav() { if(!isMobile() && currentBookType) chapterNavBar.classList.add('visible'); }
    function hideChapterNav() { if(!isMobile()) chapterNavBar.classList.remove('visible'); }
    let navHideTimer;
    readerContainer.addEventListener('mousemove', e => {
        if(isMobile()) return;
        const rect = readerContainer.getBoundingClientRect();
        clearTimeout(navHideTimer);
        if(rect.bottom - e.clientY < 80) showChapterNav();
        else hideChapterNav();
    });
    readerContainer.addEventListener('mouseleave', hideChapterNav);
    chapterNavBar.addEventListener('mouseenter', () => { clearTimeout(navHideTimer); showChapterNav(); });
    chapterNavBar.addEventListener('mouseleave', hideChapterNav);

    // ========== URL面板 ==========
    urlLoadBtn.addEventListener('click', () => {
        urlPanel.style.display = urlPanel.style.display === 'none' ? 'flex' : 'none';
        if(urlPanel.style.display === 'flex') bookUrlInput.focus();
    });
    closeUrlPanelBtn.addEventListener('click', () => urlPanel.style.display = 'none');
    loadUrlBtn.addEventListener('click', () => loadFromUrl(bookUrlInput.value));

    // ========== 移动端翻页与菜单 ==========
    function mobileTapHandler(event) {
        if(!isMobile() || !currentBookType) return;
        if(event.target === tapLeft) {
            if(currentBookType === 'epub') currentRendition?.prev();
            else if(currentBookType === 'pdf') { if(currentPdfPageNum > 1) renderPdfPage(currentPdfPageNum-1, true); }
            else if(currentBookType === 'txt') {
                const height = readerContainer.clientHeight;
                if(readerContainer.scrollTop <= 10 && smartChapterMode) {
                    if(currentChapterIndex > 0) renderTxtChapter(currentChapterIndex-1);
                } else readerContainer.scrollBy({top: -height, behavior:'smooth'});
            }
        } else if(event.target === tapRight) {
            if(currentBookType === 'epub') currentRendition?.next();
            else if(currentBookType === 'pdf') { if(currentPdfPageNum < currentPdfTotalPages) renderPdfPage(currentPdfPageNum+1, true); }
            else if(currentBookType === 'txt') {
                const height = readerContainer.clientHeight;
                const maxScroll = readerArea.scrollHeight - height;
                if(readerContainer.scrollTop >= maxScroll - 10 && smartChapterMode) {
                    if(currentChapterIndex < currentTxtChunks.length-1) renderTxtChapter(currentChapterIndex+1);
                } else readerContainer.scrollBy({top: height, behavior:'smooth'});
            }
        } else if(event.target === tapCenter) {
            toolbar.classList.toggle('show');
        }
    }
    tapLeft.addEventListener('click', mobileTapHandler);
    tapRight.addEventListener('click', mobileTapHandler);
    tapCenter.addEventListener('click', mobileTapHandler);
    readerContainer.addEventListener('click', e => {
        if(isMobile() && toolbar.classList.contains('show') && !e.target.closest('.toolbar') && e.target !== tapCenter)
            toolbar.classList.remove('show');
    });

    // ========== 其余事件绑定 ==========
    fileInput.addEventListener('change', e => {
        if(e.target.files.length) processFile(e.target.files[0]);
        fileInput.value = '';
    });
    toggleSidebarBtn.addEventListener('click', () => {
        isSidebarVisible = !isSidebarVisible;
        sidebar.classList.toggle('hide', !isSidebarVisible);
    });
    themeToggleBtn.addEventListener('click', () => setTheme(currentTheme==='light'?'dark':'light'));
    fontPlusBtn.addEventListener('click', () => adjustFontSize(10));
    fontMinusBtn.addEventListener('click', () => adjustFontSize(-10));
    smartChapterBtn.addEventListener('click', () => { if(currentBookType==='txt') toggleSmartChapterMode(); });
    prevChapterBtn.addEventListener('click', () => { if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex-1); });
    nextChapterBtn.addEventListener('click', () => { if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex+1); });
    window.addEventListener('beforeunload', saveProgress);
    initDragAndDrop();

    // 初始化配置并恢复书籍
    const cfg = loadGlobalConfig();
    setTheme(currentTheme);
    adjustFontSize(0);
    (async () => {
        if(cfg.lastBookId) {
            const record = await loadBookFromIndexedDB(cfg.lastBookId);
            if(record?.blob) {
                const file = new File([record.blob], record.fileName, {type: `application/${record.fileType}`});
                await processFile(file);
            }
        }
    })();

    // 移动端工具栏重置
    window.addEventListener('resize', () => { if(!isMobile()) toolbar.classList.remove('show'); });
})();
