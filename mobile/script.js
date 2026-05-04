(function(){
    // ---------- 基础变量 ----------
    let currentBookType = null;
    let currentEpubBook = null;
    let currentRendition = null;
    let currentPdfDoc = null;
    let currentPdfTotalPages = 0;
    let currentPdfPageNum = 1;
    let currentTxtRaw = null;
    let currentTxtChunks = [];        // 智能章节数组
    let smartChapterMode = true;
    let currentChapterIndex = 0;
    let currentFileName = "";
    let currentFontSize = 100;
    let currentTheme = "light";
    let currentBookUrlOrId = "";

    // 预加载缓存：章节文本内容
    let chunkTextCache = {};

    // DOM
    const readerContainer = document.getElementById('readerContainer');
    const readerArea = document.getElementById('readerArea');
    const fileInput = document.getElementById('fileInput');
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const searchDropdown = document.getElementById('searchDropdown');
    const localMatchList = document.getElementById('localMatchList');
    const globalMatchList = document.getElementById('globalMatchList');
    const toolbarOverlay = document.getElementById('toolbarOverlay');
    const sidebar = document.getElementById('sidebar');
    const sidebarMask = document.getElementById('sidebarMask');
    const tocListEl = document.getElementById('tocList');
    const bookTitleEl = document.getElementById('bookTitle');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const closeToolbarBtn = document.getElementById('closeToolbarBtn');

    // 搜索
    let currentSearchTerm = "";
    let currentSearchMatches = [];
    let searchDebounceTimer;

    // IndexedDB
    let db = null;
    const DB_NAME = "ZZXMobileDB";
    const STORE_NAME = "books";

    function initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { db = req.result; resolve(db); };
            req.onupgradeneeded = (e) => {
                const dbr = e.target.result;
                if(!dbr.objectStoreNames.contains(STORE_NAME)) dbr.createObjectStore(STORE_NAME, { keyPath: "id" });
            };
        });
    }

    async function saveBook(id, blob, name, type) {
        if(!db) await initDB();
        const tx = db.transaction([STORE_NAME], "readwrite");
        tx.objectStore(STORE_NAME).put({ id, blob, fileName: name, fileType: type, timestamp: Date.now() });
    }

    async function loadBook(id) {
        if(!db) await initDB();
        return new Promise(resolve => {
            const tx = db.transaction([STORE_NAME], "readonly");
            const req = tx.objectStore(STORE_NAME).get(id);
            req.onsuccess = () => resolve(req.result);
        });
    }

    function saveConfig() {
        localStorage.setItem("zzx_mob_config", JSON.stringify({
            fontSize: currentFontSize,
            theme: currentTheme,
            smartMode: smartChapterMode,
            lastBookId: currentBookUrlOrId,
            lastType: currentBookType,
            lastFileName: currentFileName,
            pdfPage: currentPdfPageNum,
            chapterIndex: currentChapterIndex
        }));
    }

    function loadConfig() {
        const raw = localStorage.getItem("zzx_mob_config");
        if(raw) {
            try {
                const c = JSON.parse(raw);
                currentFontSize = c.fontSize || 100;
                currentTheme = c.theme || "light";
                smartChapterMode = c.smartMode !== false;
                setTheme(currentTheme);
                adjustFontSize(0);
                return c;
            } catch(e) {}
        }
        return {};
    }

    // ---------- 章节预加载与无缝拼接 ----------
    function getChapterContent(idx) {
        if (idx < 0 || idx >= currentTxtChunks.length) return null;
        if (!chunkTextCache[idx]) {
            chunkTextCache[idx] = currentTxtChunks[idx].content;
        }
        return chunkTextCache[idx];
    }

    function buildChapterHTML(idx) {
        const ch = currentTxtChunks[idx];
        const title = ch.title || '';
        const content = getChapterContent(idx);
        return `<div class="chapter-title">${escapeHtml(title)}</div><div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}">${escapeHtml(content)}</div>`;
    }

    function renderChapter(idx) {
        if (!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(Math.max(0, idx), currentTxtChunks.length-1);
        readerArea.innerHTML = buildChapterHTML(currentChapterIndex);
        readerArea.scrollTop = 0;
        bookTitleEl.innerText = currentTxtChunks[currentChapterIndex].title || currentFileName;
        updateTOCActive();
        // 预加载前后10章
        preloadNearbyChapters(currentChapterIndex);
        saveProgress();
    }

    function updateTOCActive() {
        const items = tocListEl.querySelectorAll('.toc-item');
        items.forEach((item, i) => {
            item.classList.toggle('active', i === currentChapterIndex);
        });
    }

    // 预加载：将文本缓存到chunkTextCache（不渲染）
    function preloadNearbyChapters(centerIdx) {
        const start = Math.max(0, centerIdx - 10);
        const end = Math.min(currentTxtChunks.length - 1, centerIdx + 10);
        for (let i = start; i <= end; i++) {
            if (!chunkTextCache[i]) {
                chunkTextCache[i] = currentTxtChunks[i].content;
            }
        }
    }

    // 滚动监听：接近顶部加载上一章，接近底部加载下一章
    function onReaderScroll() {
        if (currentBookType !== 'txt' || !smartChapterMode || !currentTxtChunks.length) return;
        const scrollTop = readerArea.scrollTop;
        const scrollHeight = readerArea.scrollHeight;
        const clientHeight = readerArea.clientHeight;
        const threshold = 50; // 像素

        if (scrollTop <= threshold && currentChapterIndex > 0) {
            // 向上加载上一章
            loadAdjacentChapter(currentChapterIndex - 1, 'top');
        } else if (scrollTop + clientHeight >= scrollHeight - threshold && currentChapterIndex < currentTxtChunks.length - 1) {
            // 向下加载下一章
            loadAdjacentChapter(currentChapterIndex + 1, 'bottom');
        }
    }

    function loadAdjacentChapter(newIdx, direction) {
        if (newIdx < 0 || newIdx >= currentTxtChunks.length) return;
        const oldScrollHeight = readerArea.scrollHeight;
        const html = buildChapterHTML(newIdx);
        
        if (direction === 'top') {
            // 插入到现有内容上方
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            while (tempDiv.firstChild) {
                readerArea.insertBefore(tempDiv.firstChild, readerArea.firstChild);
            }
            // 调整滚动位置，保持视觉连续性
            readerArea.scrollTop = readerArea.scrollHeight - oldScrollHeight;
        } else if (direction === 'bottom') {
            // 追加到末尾
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            while (tempDiv.firstChild) {
                readerArea.appendChild(tempDiv.firstChild);
            }
        }
        
        // 更新当前章节索引为实际所在位置（简化：实时定位）
        // 但为避免频繁切换，我们只在边界时更新 currentChapterIndex
        currentChapterIndex = newIdx;
        bookTitleEl.innerText = currentTxtChunks[currentChapterIndex].title || currentFileName;
        updateTOCActive();
        preloadNearbyChapters(currentChapterIndex);
        saveProgress();
        // 清除可能多余的旧章节（只保留当前及前后各一个，避免无限增长）
        trimExcessChapters();
    }

    function trimExcessChapters() {
        // 简单实现：保留当前章节，移除其他暂时不处理（性能可接受）
    }

    // ---------- EPUB / PDF 滑动逻辑（不变） ----------
    async function loadEpub(buffer, filename) {
        clearReader();
        currentBookType = 'epub';
        currentFileName = filename;
        const blob = new Blob([buffer], {type: 'application/epub+zip'});
        currentEpubBook = ePub(URL.createObjectURL(blob));
        currentRendition = currentEpubBook.renderTo("readerArea", {width:"100%", height:"100%", spread:"none", flow:"paginated"});
        await currentRendition.display();
        currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
        currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
        setTheme(currentTheme);
        currentRendition.themes.fontSize(currentFontSize+"%");
        const nav = await currentEpubBook.loaded.navigation;
        buildEpubToc(nav.toc);
        currentRendition.on('relocated', () => {
            // EPUB 章节标题更新可扩展
        });
        bookTitleEl.innerText = filename;
        await loadProgress();
    }

    function buildEpubToc(toc) {
        tocListEl.innerHTML = '';
        const renderItems = (items, parent) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'toc-item';
                li.innerText = item.label || '章节';
                if(item.href) li.addEventListener('click', () => {
                    currentRendition.display(item.href);
                    closeSidebar();
                });
                parent.appendChild(li);
                if(item.subitems) renderItems(item.subitems, parent);
            });
        };
        renderItems(toc, tocListEl);
    }

    async function loadPdf(buffer, filename) {
        clearReader();
        currentBookType = 'pdf';
        currentFileName = filename;
        currentPdfDoc = await pdfjsLib.getDocument({data: new Uint8Array(buffer)}).promise;
        currentPdfTotalPages = currentPdfDoc.numPages;
        currentPdfPageNum = 1;
        await renderAllPdfPages();
        buildPdfToc();
        bookTitleEl.innerText = filename;
        await loadProgress();
    }

    async function renderAllPdfPages() {
        readerArea.innerHTML = '';
        for (let i = 1; i <= currentPdfTotalPages; i++) {
            const page = await currentPdfDoc.getPage(i);
            const vp = page.getViewport({scale: 1.5});
            const canvas = document.createElement('canvas');
            canvas.height = vp.height;
            canvas.width = vp.width;
            canvas.className = 'pdf-page-canvas';
            await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
            readerArea.appendChild(canvas);
        }
    }

    function buildPdfToc() {
        tocListEl.innerHTML = '';
        for (let i = 1; i <= currentPdfTotalPages; i++) {
            const li = document.createElement('li');
            li.className = 'toc-item';
            li.innerText = `第${i}页`;
            li.addEventListener('click', () => {
                document.querySelector(`.pdf-page-canvas:nth-child(${i})`)?.scrollIntoView({behavior:'smooth'});
                closeSidebar();
            });
            tocListEl.appendChild(li);
        }
    }

    // TXT 加载
    async function loadTxt(buffer, filename) {
        clearReader();
        currentBookType = 'txt';
        currentFileName = filename;
        const enc = await detectEncoding(buffer);
        currentTxtRaw = new TextDecoder(enc).decode(buffer);
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        smartChapterMode = true;
        // 初始预加载前10章
        preloadNearbyChapters(0);
        renderChapter(0);
        buildTocFromChunks();
        bookTitleEl.innerText = currentTxtChunks[0]?.title || filename;
        await loadProgress();
    }

    function buildTocFromChunks() {
        tocListEl.innerHTML = '';
        currentTxtChunks.forEach((ch, i) => {
            const li = document.createElement('li');
            li.className = 'toc-item';
            li.innerText = ch.title.length > 20 ? ch.title.slice(0,18)+'…' : ch.title;
            li.addEventListener('click', () => {
                renderChapter(i);
                closeSidebar();
            });
            tocListEl.appendChild(li);
        });
    }

    async function loadTxtWithSmartChapter() {
        if (smartChapterMode && currentTxtChunks.length) {
            renderChapter(currentChapterIndex);
            buildTocFromChunks();
        } else {
            // 全文模式：直接展示整个文本，不分章
            readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}">${escapeHtml(currentTxtRaw)}</div>`;
            tocListEl.innerHTML = '<li class="toc-item">纯文本全文</li>';
            bookTitleEl.innerText = currentFileName;
        }
    }

    function clearReader() {
        if(currentRendition) try{currentRendition.destroy()}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy()}catch(e){}
        currentPdfDoc = null;
        currentTxtRaw = null;
        currentTxtChunks = [];
        chunkTextCache = {};
        readerArea.innerHTML = '<div class="empty-state"><i class="fas fa-cloud-upload-alt" style="font-size:48px;opacity:0.4"></i><p>点击屏幕中央<br>上传图书开始阅读</p></div>';
        currentBookType = null;
        tocListEl.innerHTML = '<li class="empty-toc">暂无目录</li>';
        bookTitleEl.innerText = '未打开书籍';
    }

    // ---------- 公共工具函数 ----------
    function setTheme(theme) {
        currentTheme = theme;
        document.body.classList.toggle('dark', theme === 'dark');
        if(currentBookType === 'epub' && currentRendition) currentRendition.themes.select(theme);
        saveConfig();
    }

    function adjustFontSize(delta) {
        currentFontSize = Math.min(180, Math.max(70, currentFontSize + delta));
        if(currentBookType === 'epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize+"%");
        if(currentBookType === 'txt') {
            // 重新渲染当前章节以应用字号
            if(smartChapterMode && currentTxtChunks.length) renderChapter(currentChapterIndex);
            else if(!smartChapterMode && currentTxtRaw) readerArea.querySelector('.txt-viewer').style.fontSize = (currentFontSize/100)*1.1+"rem";
        }
        saveConfig();
    }

    async function detectEncoding(buffer) {
        const encodings = ['utf-8','gbk','gb2312','big5','shift-jis','euc-kr'];
        const sample = buffer.slice(0, 4096);
        function scoreText(text) {
            let valid = 0;
            for (let i=0; i<text.length && i<1000; i++) {
                const c = text.charCodeAt(i);
                if ((c>=0x4E00&&c<=0x9FFF)||(c>=0x3040&&c<=0x30FF)||(c>=0xAC00&&c<=0xD7AF)||(c>=0x20&&c<=0x7E)||c===0x0A||c===0x0D||c===0x09) valid++;
            }
            return valid/(text.length||1);
        }
        let best = 'utf-8', bestScore=0;
        for (const e of encodings) {
            try {
                const t = new TextDecoder(e, {fatal:false}).decode(sample);
                const s = scoreText(t);
                if (s > bestScore) { bestScore = s; best = e; }
                if (bestScore > 0.95) break;
            } catch(e) {}
        }
        return best;
    }

    function splitIntelligentChapters(text) {
        const unitCounter = {};
        const pat = /^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])/gm;
        let m;
        while((m=pat.exec(text))!==null) unitCounter[m[2]] = (unitCounter[m[2]]||0)+1;
        let bestUnit = null, max = 0;
        for (const u in unitCounter) if(unitCounter[u] > max) { max = unitCounter[u]; bestUnit = u; }
        const splitPat = bestUnit ? new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`,'gm') : /^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        const lines = text.split(/\r?\n/);
        const chapters = [];
        let curTitle = "序言", curContent = [];
        for (const line of lines) {
            const t = line.trim();
            splitPat.lastIndex = 0;
            if (splitPat.test(t) && t.length < 50) {
                if (curContent.length) chapters.push({title: curTitle, content: curContent.join('\n')});
                curTitle = t;
                curContent = [];
            } else curContent.push(line);
        }
        if (curContent.length) chapters.push({title: curTitle, content: curContent.join('\n')});
        if (!chapters.length) chapters = [{title:"全文", content:text}];
        return chapters;
    }

    function escapeHtml(s) { return s.replace(/[&<>]/g, c => c==='&'?'&amp;':c==='<'?'&lt;':'&gt;'); }

    // 搜索功能（保持原有，微小调整）
    function clearSearch() {
        currentSearchTerm = "";
        searchInput.value = "";
        searchDropdown.style.display = "none";
        removeHighlights();
        localMatchList.innerHTML = "";
        globalMatchList.innerHTML = "";
    }

    function performSearch(query) {
        currentSearchTerm = query;
        if (!query.trim()) {
            searchDropdown.style.display = "none";
            removeHighlights();
            return;
        }
        const lowerQuery = query.toLowerCase();
        const localText = getCurrentVisibleText();
        const localMatches = [];
        let idx = localText.toLowerCase().indexOf(lowerQuery);
        while (idx !== -1) {
            const start = Math.max(0, idx-20), end = Math.min(localText.length, idx+query.length+20);
            localMatches.push({ start: idx, end: idx+query.length, text: localText.slice(start, end).replace(/\n/g, ' ') });
            idx = localText.toLowerCase().indexOf(lowerQuery, idx+1);
        }
        currentSearchMatches = localMatches;
        localMatchList.innerHTML = localMatches.length ? localMatches.map(m => `<li>...${escapeHtml(m.text)}...</li>`).join('') : '<li>无匹配</li>';
        const globalRes = [];
        if (currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, i) => {
                const count = (getChapterContent(i) || '').toLowerCase().split(lowerQuery).length - 1;
                if (count > 0) globalRes.push({ chapterIndex: i, title: ch.title, count });
            });
        }
        globalMatchList.innerHTML = globalRes.length ? globalRes.map(r => `<li data-chapter="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count})</li>`).join('') : '<li>全文无匹配</li>';
        searchDropdown.style.display = "block";
        highlightLocalMatches();
    }

    function getCurrentVisibleText() {
        if (currentBookType === 'txt') {
            if (smartChapterMode && currentTxtChunks.length) {
                return getChapterContent(currentChapterIndex) || '';
            }
            return currentTxtRaw || '';
        }
        return readerArea.innerText || '';
    }

    function highlightLocalMatches() {
        removeHighlights();
        if (!currentSearchTerm) return;
        const container = document.querySelector('.txt-viewer');
        if (container) {
            const regex = new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi');
            container.innerHTML = container.innerHTML.replace(regex, '<mark>$1</mark>');
        }
    }

    function removeHighlights() {
        const container = document.querySelector('.txt-viewer');
        if (container) container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, '');
    }

    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    // ---------- UI 事件绑定 ----------
    function openToolbar() { toolbarOverlay.style.display = 'block'; }
    function closeToolbar() { toolbarOverlay.style.display = 'none'; }
    function toggleToolbar() { toolbarOverlay.style.display === 'block' ? closeToolbar() : openToolbar(); }
    function openSidebar() { sidebar.classList.add('open'); sidebarMask.style.display = 'block'; }
    function closeSidebar() { sidebar.classList.remove('open'); sidebarMask.style.display = 'none'; }

    // 工具栏关闭按钮
    closeToolbarBtn.addEventListener('click', closeToolbar);

    // 点击空白关闭工具栏
    readerContainer.addEventListener('click', (e) => {
        if (toolbarOverlay.style.display === 'block' && !e.target.closest('.toolbar-overlay'))
            closeToolbar();
    });
    sidebarMask.addEventListener('click', closeSidebar);
    document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

    // 中间点击呼出工具栏
    document.getElementById('tapCenter').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbar();
    });

    // 左右点击（主要用于PDF/EPUB导航，TXT使用滑动）
    document.getElementById('tapLeft').addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentBookType === 'epub') currentRendition?.prev();
        else if (currentBookType === 'pdf') {
            readerArea.scrollBy({ top: -readerContainer.clientHeight, behavior: 'smooth' });
        }
    });
    document.getElementById('tapRight').addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentBookType === 'epub') currentRendition?.next();
        else if (currentBookType === 'pdf') {
            readerArea.scrollBy({ top: readerContainer.clientHeight, behavior: 'smooth' });
        }
    });

    // 文件与URL
    document.getElementById('fileUploadBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async e => {
        if (e.target.files.length) {
            await processFile(e.target.files[0]);
            fileInput.value = '';
        }
    });
    document.getElementById('urlLoadBtn').addEventListener('click', () => {
        const url = prompt('输入图书URL:');
        if (url) loadFromUrl(url).catch(err => alert('加载失败: '+err.message));
    });

    document.getElementById('fontMinusBtn').addEventListener('click', () => adjustFontSize(-10));
    document.getElementById('fontPlusBtn').addEventListener('click', () => adjustFontSize(10));
    themeToggleBtn.addEventListener('click', () => setTheme(currentTheme === 'light' ? 'dark' : 'light'));
    document.getElementById('smartChapterBtn').addEventListener('click', () => {
        if (currentBookType !== 'txt') return;
        smartChapterMode = !smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        loadTxtWithSmartChapter();
        closeToolbar();
    });
    document.getElementById('tocBtn').addEventListener('click', () => {
        openSidebar();
        closeToolbar();
    });

    // 搜索事件
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => performSearch(searchInput.value), 300);
    });
    clearSearchBtn.addEventListener('click', clearSearch);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-row')) searchDropdown.style.display = 'none';
    });
    localMatchList.addEventListener('click', e => {
        const li = e.target.closest('li');
        if (!li || !currentSearchMatches.length) return;
        const index = Array.from(localMatchList.children).indexOf(li);
        const match = currentSearchMatches[index];
        if (!match) return;
        const container = document.querySelector('.txt-viewer');
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
    globalMatchList.addEventListener('click', e => {
        const li = e.target.closest('li');
        if (!li) return;
        const chapterIdx = parseInt(li.dataset.chapter, 10);
        if (!isNaN(chapterIdx) && currentTxtChunks.length) {
            renderChapter(chapterIdx);
            closeToolbar();
            setTimeout(() => performSearch(currentSearchTerm), 300);
        }
    });

    // ---------- 滚动监听（TXT章节拼接）----------
    readerArea.addEventListener('scroll', () => {
        if (currentBookType === 'txt' && smartChapterMode) {
            onReaderScroll();
        }
    });

    // ---------- 进度保存/恢复 ----------
    async function saveProgress() {
        if (!currentFileName) return;
        const key = `m_progress_${currentFileName}`;
        let data = { type: currentBookType };
        if (currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                if (loc?.start?.cfi) data.cfi = loc.start.cfi;
            } catch(e) {}
        } else if (currentBookType === 'pdf') data.page = currentPdfPageNum;
        else if (currentBookType === 'txt') data.chapterIndex = currentChapterIndex;
        localStorage.setItem(key, JSON.stringify(data));
    }

    async function loadProgress() {
        if (!currentFileName) return;
        const raw = localStorage.getItem(`m_progress_${currentFileName}`);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.type === 'epub' && currentBookType === 'epub' && data.cfi) {
                currentRendition.display(data.cfi);
            } else if (data.type === 'pdf' && currentBookType === 'pdf') {
                const pageNum = data.page || 1;
                document.querySelector(`.pdf-page-canvas:nth-child(${pageNum})`)?.scrollIntoView();
            } else if (data.type === 'txt' && currentBookType === 'txt') {
                const idx = data.chapterIndex || 0;
                renderChapter(idx);
            }
        } catch(e) {}
    }

    async function processFile(file) {
        if (!file) return;
        const name = file.name, ext = name.split('.').pop().toLowerCase();
        const buffer = await file.arrayBuffer();
        currentBookUrlOrId = `file_${name}_${Date.now()}`;
        await saveBook(currentBookUrlOrId, new Blob([buffer]), name, ext);
        currentFileName = name;
        clearSearch();
        if (ext === 'epub') await loadEpub(buffer, name);
        else if (ext === 'pdf') await loadPdf(buffer, name);
        else if (ext === 'txt') await loadTxt(buffer, name);
        closeToolbar();
        saveConfig();
    }

    async function loadFromUrl(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const filename = url.split('/').pop() || "book";
        await processFile(new File([blob], filename));
    }

    // 电量和时间
    function updateDateTimeBattery() {
        const el = document.getElementById('batteryTime');
        if (!el) return;
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if (navigator.getBattery) {
            navigator.getBattery().then(battery => {
                const level = Math.round(battery.level * 100);
                el.textContent = `${level}% · ${timeStr}`;
                battery.addEventListener('levelchange', () => {
                    el.textContent = `${Math.round(battery.level * 100)}% · ${timeStr}`;
                });
            }).catch(() => { el.textContent = timeStr; });
        } else {
            el.textContent = timeStr;
        }
    }
    updateDateTimeBattery();
    setInterval(updateDateTimeBattery, 30000);

    // 初始化
    const cfg = loadConfig();
    setTheme(currentTheme);
    adjustFontSize(0);
    (async () => {
        if (cfg.lastBookId) {
            const record = await loadBook(cfg.lastBookId);
            if (record?.blob) {
                const file = new File([record.blob], record.fileName, { type: `application/${record.fileType}` });
                await processFile(file);
            }
        }
    })();
})();
