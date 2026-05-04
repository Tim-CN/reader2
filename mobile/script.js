(function(){
    // 全局变量
    let currentBookType = null;      // 'epub', 'pdf', 'txt'
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
    let currentLineHeight = 1.7;
    let currentBookId = "";

    // IndexedDB
    let db = null;
    const DB_NAME = "ZZXReaderDB";
    const STORE_NAME = "books";

    // 搜索相关
    let currentSearchTerm = "";
    let searchDebounceTimer = null;
    let chapterSearchIndex = null;    // 预处理搜索索引

    // DOM 元素
    const readerArea = document.getElementById('readerArea');
    const readerContainer = document.getElementById('readerContainer');
    const bookTitleSpan = document.getElementById('bookTitle');
    const tocListMobile = document.getElementById('tocListMobile');
    const bottomBar = document.getElementById('bottomActionBar');
    const drawerMenu = document.getElementById('drawerMenu');
    const drawerOverlay = document.getElementById('drawerOverlay');
    const searchPanel = document.getElementById('searchPanel');
    const mobileSearchInput = document.getElementById('mobileSearchInput');
    const searchResultList = document.getElementById('searchResultList');
    const moreMenu = document.getElementById('moreMenu');
    const urlModal = document.getElementById('urlModal');
    const loadingToast = document.getElementById('loadingToast');
    const chapterNavMobile = document.getElementById('chapterNavBarMobile');
    const chapterTitleMobile = document.getElementById('chapterTitleMobile');

    // 辅助函数
    function showLoading(show, text = "加载中...") {
        loadingToast.innerText = text;
        loadingToast.style.display = show ? "block" : "none";
    }

    // IndexedDB 初始化
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
                if(!dbRef.objectStoreNames.contains(STORE_NAME)) {
                    dbRef.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };
        });
    }

    async function saveBookToIndexedDB(id, fileBlob, fileName, fileType) {
        if(!db) await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const record = { id, blob: fileBlob, fileName, fileType, timestamp: Date.now() };
            store.put(record);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async function loadBookFromIndexedDB(id) {
        if(!db) await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function saveGlobalConfig() {
        const config = {
            fontSize: currentFontSize,
            theme: currentTheme,
            lineHeight: currentLineHeight,
            lastBookId: currentBookId,
            lastBookType: currentBookType,
            lastFileName: currentFileName,
            smartChapterMode
        };
        localStorage.setItem("zzx_reader_config_mobile", JSON.stringify(config));
    }

    function loadGlobalConfig() {
        const raw = localStorage.getItem("zzx_reader_config_mobile");
        if(raw) {
            try {
                const cfg = JSON.parse(raw);
                currentFontSize = cfg.fontSize || 100;
                currentTheme = cfg.theme || "light";
                currentLineHeight = cfg.lineHeight || 1.7;
                smartChapterMode = cfg.smartChapterMode || false;
                setTheme(currentTheme);
                applyFontAndLineHeight();
                return cfg;
            } catch(e) {}
        }
        return {};
    }

    function applyFontAndLineHeight() {
        if(currentBookType === 'txt') {
            const txtViewer = document.querySelector('.txt-viewer');
            if(txtViewer) {
                txtViewer.style.fontSize = (currentFontSize/100) * 1.0 + 'rem';
                txtViewer.style.lineHeight = currentLineHeight;
            }
        }
        if(currentBookType === 'epub' && currentRendition) {
            currentRendition.themes.fontSize(currentFontSize + "%");
        }
        // PDF 字体由 canvas 渲染，无 font-size 调整
        document.querySelector('.font-size-value').innerText = currentFontSize + '%';
        document.getElementById('lineHeightSlider').value = currentLineHeight;
        document.getElementById('lineHeightValue').innerText = currentLineHeight;
    }

    function setTheme(theme) {
        currentTheme = theme;
        if(theme === 'dark') {
            document.body.classList.add('dark');
        } else {
            document.body.classList.remove('dark');
        }
        if(currentBookType === 'epub' && currentRendition) {
            currentRendition.themes.select(theme);
        }
        if(currentBookType === 'txt') {
            const txtViewer = document.querySelector('.txt-viewer');
            if(txtViewer) {
                txtViewer.style.color = theme === 'dark' ? '#e2e8f0' : '#1e293b';
            }
        }
        saveGlobalConfig();
    }

    async function saveProgress() {
        if(!currentFileName) return;
        const key = `progress_${currentFileName}`;
        let progressData = { type: currentBookType, smartMode: smartChapterMode };
        if(currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                if(loc && loc.start && loc.start.cfi) progressData.cfi = loc.start.cfi;
            } catch(e) {}
        } else if(currentBookType === 'pdf' && currentPdfDoc) {
            progressData.page = currentPdfPageNum;
        } else if(currentBookType === 'txt') {
            if(smartChapterMode) {
                progressData.smartChapterIndex = currentChapterIndex;
            } else {
                const scrollPercent = readerContainer.scrollTop / (readerArea.scrollHeight - readerContainer.clientHeight);
                progressData.scrollRatio = isNaN(scrollPercent) ? 0 : scrollPercent;
            }
        }
        localStorage.setItem(key, JSON.stringify(progressData));
        saveGlobalConfig();
    }

    async function loadProgressForCurrent() {
        if(!currentFileName) return;
        const key = `progress_${currentFileName}`;
        const raw = localStorage.getItem(key);
        if(!raw) return;
        try {
            const data = JSON.parse(raw);
            if(data.type === 'epub' && currentBookType === 'epub' && currentRendition && data.cfi) {
                await currentRendition.display(data.cfi);
            } else if(data.type === 'pdf' && currentBookType === 'pdf' && currentPdfDoc && data.page) {
                await renderPdfPage(data.page, true);
            } else if(data.type === 'txt' && currentBookType === 'txt') {
                if(data.smartMode !== undefined) smartChapterMode = data.smartMode;
                updateSmartChapterUI();
                if(smartChapterMode && currentTxtChunks.length > 0) {
                    let idx = data.smartChapterIndex || 0;
                    if(idx >= currentTxtChunks.length) idx = 0;
                    await renderTxtChapter(idx);
                } else if(!smartChapterMode && data.scrollRatio !== undefined) {
                    await renderFullTxtLazy();
                    setTimeout(() => {
                        const totalScroll = readerArea.scrollHeight - readerContainer.clientHeight;
                        readerContainer.scrollTop = totalScroll * data.scrollRatio;
                    }, 100);
                }
            }
        } catch(e) { console.warn(e); }
    }

    // 编码检测
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
            } catch(e) {}
        }
        return bestEncoding;
    }

    // 智能章节分割
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
                if (currentContent.length) {
                    chapters.push({ title: currentTitle, content: currentContent.join('\n') });
                }
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

    async function renderTxtChapter(index) {
        if(!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(Math.max(0, index), currentTxtChunks.length-1);
        const chapter = currentTxtChunks[currentChapterIndex];
        const htmlContent = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.0}rem; line-height:${currentLineHeight}; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"><h3 style="margin-bottom:1rem;">${escapeHtml(chapter.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(chapter.content)}</div></div>`;
        readerArea.innerHTML = htmlContent;
        updateTocForSmartChapters();
        chapterTitleMobile.innerText = chapter.title;
        chapterNavMobile.style.display = 'flex';
        readerContainer.scrollTop = 0;
        if(currentSearchTerm) performSearch(currentSearchTerm);
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if(!smartChapterMode || !currentTxtChunks.length) return;
        tocListMobile.innerHTML = '';
        currentTxtChunks.forEach((ch, idx) => {
            const li = document.createElement('li');
            if(idx === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length > 30 ? ch.title.slice(0,28)+'...' : ch.title;
            li.addEventListener('click', () => renderTxtChapter(idx));
            tocListMobile.appendChild(li);
        });
    }

    async function renderFullTxtLazy() {
        if(!currentTxtRaw) return;
        readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.0}rem; line-height:${currentLineHeight}; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"></div>`;
        const containerDiv = readerArea.querySelector('.txt-viewer');
        const chunkSize = 50000;
        let index = 0;
        function renderNextChunk() {
            const nextChunk = currentTxtRaw.slice(index, index+chunkSize);
            if(nextChunk) {
                const textNode = document.createTextNode(nextChunk);
                containerDiv.appendChild(textNode);
                index += chunkSize;
                requestAnimationFrame(() => {
                    if(index < currentTxtRaw.length) renderNextChunk();
                    else { if(currentSearchTerm) performSearch(currentSearchTerm); saveProgress(); }
                });
            } else {
                saveProgress();
            }
        }
        renderNextChunk();
        chapterNavMobile.style.display = 'none';
    }

    function escapeHtml(str) {
        return str.replace(/[&<>]/g, function(m){
            if(m==='&') return '&amp;';
            if(m==='<') return '&lt;';
            if(m==='>') return '&gt;';
            return m;
        });
    }

    async function loadTxtSmartOrPlain(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'txt';
        currentFileName = filename;
        bookTitleSpan.innerText = filename.replace(/\.[^/.]+$/, '');
        const encoding = await detectEncoding(arrayBuffer);
        const decoder = new TextDecoder(encoding);
        currentTxtRaw = decoder.decode(arrayBuffer);
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        const savedMode = localStorage.getItem(`txt_smart_mode_${filename}`);
        smartChapterMode = (savedMode === 'true') ? true : false;
        updateSmartChapterUI();
        if(smartChapterMode && currentTxtChunks.length > 0) {
            await renderTxtChapter(0);
        } else {
            await renderFullTxtLazy();
            buildTxtSimpleToc();
        }
        bindScrollSave();
        await loadProgressForCurrent();
        if(currentSearchTerm) performSearch(currentSearchTerm);
        buildSearchIndexFromTxt();   // 构建搜索索引
    }

    function buildTxtSimpleToc() {
        tocListMobile.innerHTML = '<li class="toc-item" style="text-align:center;">纯文本模式</li><li id="enableSmartToc" style="padding:12px 20px; background:#f0f9ff; margin-top:8px; text-align:center; border-radius:8px; cursor:pointer;">🔍 开启智能章节分割</li>';
        const enableBtn = document.getElementById('enableSmartToc');
        if(enableBtn) enableBtn.addEventListener('click', () => { toggleSmartChapterMode(true); });
    }

    function toggleSmartChapterMode(forceEnable) {
        if(currentBookType !== 'txt') return;
        smartChapterMode = forceEnable !== undefined ? forceEnable : !smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        updateSmartChapterUI();
        if(smartChapterMode && currentTxtChunks.length) {
            renderTxtChapter(currentChapterIndex);
        } else if(!smartChapterMode) {
            renderFullTxtLazy();
            chapterNavMobile.style.display = 'none';
            buildTxtSimpleToc();
        }
        saveProgress();
    }

    function updateSmartChapterUI() {
        const menuItem = document.getElementById('menuSmartChapter');
        if(menuItem && currentBookType === 'txt' && smartChapterMode) {
            menuItem.style.color = '#3b82f6';
        } else if(menuItem) {
            menuItem.style.color = '';
        }
    }

    // EPUB 逻辑
    async function loadEpub(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'epub';
        currentFileName = filename;
        bookTitleSpan.innerText = filename.replace(/\.[^/.]+$/, '');
        showLoading(true);
        try {
            const blob = new Blob([arrayBuffer], {type:"application/epub+zip"});
            const url = URL.createObjectURL(blob);
            currentEpubBook = ePub(url);
            currentRendition = currentEpubBook.renderTo("readerArea", { width:"100%", height:"100%", spread:"none", flow:"paginated" });
            await currentRendition.display();
            currentRendition.themes.register('light', { body: { background: '#ffffff', color: '#1e293b' } });
            currentRendition.themes.register('dark', { body: { background: '#111827', color: '#e2e8f0' } });
            setTheme(currentTheme);
            currentRendition.themes.fontSize(currentFontSize + "%");
            const nav = await currentEpubBook.loaded.navigation;
            buildEpubToc(nav.toc);
            currentRendition.on('relocated', () => saveProgress());
            await loadProgressForCurrent();
            showLoading(false);
        } catch(e) {
            showLoading(false);
            readerArea.innerHTML = `<div class="empty-state">EPUB解析失败</div>`;
        }
    }

    function buildEpubToc(toc) {
        tocListMobile.innerHTML = '';
        const render = (items, parent) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.innerText = item.label || '章节';
                if(item.href) li.addEventListener('click', () => currentRendition.display(item.href));
                parent.appendChild(li);
                if(item.subitems) render(item.subitems, parent);
            });
        };
        render(toc, tocListMobile);
    }

    // PDF 逻辑
    async function loadPdf(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'pdf';
        currentFileName = filename;
        bookTitleSpan.innerText = filename.replace(/\.[^/.]+$/, '');
        showLoading(true);
        try {
            const typedArray = new Uint8Array(arrayBuffer);
            currentPdfDoc = await pdfjsLib.getDocument({ data: typedArray }).promise;
            currentPdfTotalPages = currentPdfDoc.numPages;
            await renderPdfPage(1);
            bindScrollSave();
            await loadProgressForCurrent();
            showLoading(false);
        } catch(e) {
            showLoading(false);
            readerArea.innerHTML = `<div class="empty-state">PDF加载失败</div>`;
        }
    }

    async function renderPdfPage(pageNumber, isJump = false) {
        if(!currentPdfDoc) return;
        currentPdfPageNum = Math.min(Math.max(1, pageNumber), currentPdfTotalPages);
        readerArea.innerHTML = `<div class="pdf-viewer" id="pdfViewer"></div>`;
        const container = document.getElementById('pdfViewer');
        for(let i = 1; i <= currentPdfTotalPages; i++) {
            const page = await currentPdfDoc.getPage(i);
            const viewport = page.getViewport({ scale: 1.2 });
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
                if(e.isIntersecting) {
                    const p = parseInt(e.target.dataset.pageNum);
                    if(!isNaN(p)) currentPdfPageNum = p;
                    saveProgress();
                }
            });
        }, { threshold: 0.5 });
        document.querySelectorAll('.pdf-page-canvas').forEach(canvas => observer.observe(canvas));
        if(isJump) {
            document.querySelector(`.pdf-page-canvas[data-page-num='${currentPdfPageNum}']`)?.scrollIntoView({ behavior: 'smooth' });
        }
        buildPdfToc();
    }

    function buildPdfToc() {
        tocListMobile.innerHTML = '';
        for(let i = 1; i <= currentPdfTotalPages; i++) {
            const li = document.createElement('li');
            li.innerText = `第 ${i} 页`;
            li.addEventListener('click', () => renderPdfPage(i, true));
            tocListMobile.appendChild(li);
        }
    }

    function clearReader() {
        if(currentRendition) try { currentRendition.destroy(); } catch(e) {}
        if(currentEpubBook) try { currentEpubBook.destroy(); } catch(e) {}
        currentPdfDoc = null;
        currentTxtRaw = null;
        currentTxtChunks = [];
        readerArea.innerHTML = '';
        currentBookType = null;
        tocListMobile.innerHTML = '<li style="padding:20px;text-align:center;">暂无目录</li>';
        chapterNavMobile.style.display = 'none';
        clearSearch();
    }

    function bindScrollSave() {
        let saveTimer = null;
        readerContainer.addEventListener('scroll', () => {
            if(saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => saveProgress(), 600);
        });
    }

    // ========== 搜索功能 (移动端增强版) ==========
    // 为全文搜索建立索引
    function buildSearchIndexFromTxt() {
        if(currentBookType !== 'txt' || !currentTxtRaw) return;
        chapterSearchIndex = [];
        if(smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, idx) => {
                chapterSearchIndex.push({
                    type: 'chapter',
                    index: idx,
                    title: ch.title,
                    content: ch.content
                });
            });
        } else {
            chapterSearchIndex.push({
                type: 'full',
                index: 0,
                title: '全文',
                content: currentTxtRaw
            });
        }
    }

    function performSearch(query) {
        currentSearchTerm = query;
        if(!query.trim()) {
            searchResultList.innerHTML = '<li>请输入关键词</li>';
            return;
        }
        const lowerQuery = query.toLowerCase();

        if(currentBookType === 'txt' && chapterSearchIndex) {
            const results = [];
            chapterSearchIndex.forEach(sec => {
                const content = sec.content;
                const matches = [];
                let idx = content.toLowerCase().indexOf(lowerQuery);
                while(idx !== -1) {
                    const start = Math.max(0, idx - 40);
                    const end = Math.min(content.length, idx + query.length + 40);
                    matches.push({
                        start: idx,
                        end: idx + query.length,
                        excerpt: content.slice(start, end).replace(/\n/g, ' ')
                    });
                    idx = content.toLowerCase().indexOf(lowerQuery, idx + 1);
                }
                if(matches.length) {
                    results.push({
                        section: sec,
                        matches: matches,
                        count: matches.length
                    });
                }
            });

            if(results.length) {
                searchResultList.innerHTML = '';
                results.forEach(res => {
                    const sectionDiv = document.createElement('div');
                    sectionDiv.className = 'result-section';
                    const title = document.createElement('div');
                    title.style.fontWeight = 'bold';
                    title.style.margin = '12px 0 8px';
                    title.style.color = '#3b82f6';
                    title.innerText = res.section.title + ` (${res.count}处)`;
                    sectionDiv.appendChild(title);
                    res.matches.forEach((match, idx) => {
                        const item = document.createElement('li');
                        item.innerHTML = `...${escapeHtml(match.excerpt)}...`;
                        item.setAttribute('data-section-type', res.section.type);
                        item.setAttribute('data-section-index', res.section.index);
                        item.setAttribute('data-match-start', match.start);
                        item.setAttribute('data-match-end', match.end);
                        item.style.cursor = 'pointer';
                        item.addEventListener('click', () => {
                            jumpToSearchResult(res.section, match.start);
                        });
                        sectionDiv.appendChild(item);
                    });
                    searchResultList.appendChild(sectionDiv);
                });
            } else {
                searchResultList.innerHTML = '<li>未找到匹配内容</li>';
            }
        } else if(currentBookType === 'epub' && currentRendition) {
            currentRendition.search(query).then(results => {
                if(results && results.length) {
                    searchResultList.innerHTML = results.map(r => `<li data-cfi="${r.cfi}">${escapeHtml(r.excerpt)}</li>`).join('');
                    document.querySelectorAll('#searchResultList li[data-cfi]').forEach(li => {
                        li.addEventListener('click', async () => {
                            const cfi = li.dataset.cfi;
                            if(cfi && currentRendition) {
                                await currentRendition.display(cfi);
                                closeSearchPanel();
                                setTimeout(() => performSearch(query), 300);
                            }
                        });
                    });
                } else {
                    searchResultList.innerHTML = '<li>未找到匹配内容</li>';
                }
            }).catch(() => {
                searchResultList.innerHTML = '<li>搜索失败</li>';
            });
        } else {
            searchResultList.innerHTML = '<li>当前格式暂不支持全文搜索</li>';
        }
    }

    function jumpToSearchResult(section, startPos) {
        if(section.type === 'chapter' && smartChapterMode && currentTxtChunks[section.index]) {
            renderTxtChapter(section.index).then(() => {
                setTimeout(() => {
                    const walker = document.createTreeWalker(
                        document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer'),
                        NodeFilter.SHOW_TEXT
                    );
                    let node, offset = 0;
                    while((node = walker.nextNode())) {
                        const len = node.textContent.length;
                        if(offset + len > startPos) {
                            const range = document.createRange();
                            range.setStart(node, startPos - offset);
                            range.collapse(true);
                            range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            break;
                        }
                        offset += len;
                    }
                    highlightMatchesInView();
                }, 200);
            });
        } else if(section.type === 'full') {
            readerContainer.scrollTop = 0;
            setTimeout(() => {
                const walker = document.createTreeWalker(
                    document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer'),
                    NodeFilter.SHOW_TEXT
                );
                let node, offset = 0;
                while((node = walker.nextNode())) {
                    const len = node.textContent.length;
                    if(offset + len > startPos) {
                        const range = document.createRange();
                        range.setStart(node, startPos - offset);
                        range.collapse(true);
                        range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        break;
                    }
                    offset += len;
                }
                highlightMatchesInView();
            }, 50);
        }
        closeSearchPanel();
    }

    function highlightMatchesInView() {
        if(!currentSearchTerm) return;
        const container = document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer');
        if(!container) return;
        const regex = new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi');
        container.innerHTML = container.innerHTML.replace(regex, '<mark>$1</mark>');
    }

    function clearHighlights() {
        const container = document.querySelector('.txt-viewer div') || document.querySelector('.txt-viewer');
        if(container) {
            container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, '');
        }
    }

    function clearSearch() {
        currentSearchTerm = "";
        mobileSearchInput.value = "";
        searchResultList.innerHTML = '';
        clearHighlights();
    }

    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function openSearchPanel() {
        searchPanel.style.display = 'flex';
        mobileSearchInput.focus();
    }

    function closeSearchPanel() {
        searchPanel.style.display = 'none';
        if(!currentSearchTerm) clearSearch();
    }

    // ========== 文件处理 ==========
    async function processFile(file) {
        if(!file) return;
        const name = file.name;
        const ext = name.split('.').pop().toLowerCase();
        const buffer = await file.arrayBuffer();
        const fileId = `mobile_${name}_${Date.now()}`;
        currentBookId = fileId;
        await saveBookToIndexedDB(fileId, new Blob([buffer]), name, ext);
        clearSearch();
        if(ext === 'epub') await loadEpub(buffer, name);
        else if(ext === 'pdf') await loadPdf(buffer, name);
        else if(ext === 'txt') await loadTxtSmartOrPlain(buffer, name);
        else alert("不支持该格式");
        saveGlobalConfig();
    }

    async function loadFromUrl(url) {
        if(!url.trim()) return;
        showLoading(true, "获取远程文件...");
        try {
            const resp = await fetch(url);
            if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const ext = url.split('.').pop().split('?')[0].toLowerCase();
            const filename = url.split('/').pop() || "book";
            const file = new File([blob], filename, { type: blob.type });
            await processFile(file);
            urlModal.style.display = 'none';
        } catch(err) {
            alert("加载失败:" + err.message);
        } finally {
            showLoading(false);
        }
    }

    // UI 交互
    function showBottomBar() {
        bottomBar.classList.add('visible');
        setTimeout(() => {
            if(bottomBar.matches(':hover')) return;
            bottomBar.classList.remove('visible');
        }, 3000);
    }

    // 触摸屏中央唤出底部栏
    readerContainer.addEventListener('click', (e) => {
        if(bottomBar.classList.contains('visible')) {
            bottomBar.classList.remove('visible');
        } else {
            showBottomBar();
        }
        // 关闭其他浮层
        moreMenu.style.display = 'none';
    });

    // 显示抽屉
    function openDrawer() {
        drawerMenu.classList.add('open');
        drawerOverlay.classList.add('visible');
    }

    function closeDrawer() {
        drawerMenu.classList.remove('open');
        drawerOverlay.classList.remove('visible');
    }

    // 更多菜单
    function toggleMoreMenu() {
        if(moreMenu.style.display === 'none') {
            moreMenu.style.display = 'block';
        } else {
            moreMenu.style.display = 'none';
        }
    }

    // 字号调整
    function adjustFontSize(delta) {
        let newSize = currentFontSize + delta;
        if(newSize < 70) newSize = 70;
        if(newSize > 180) newSize = 180;
        currentFontSize = newSize;
        applyFontAndLineHeight();
        saveGlobalConfig();
    }

    // 行距调整
    function setLineHeight(val) {
        currentLineHeight = parseFloat(val);
        document.getElementById('lineHeightValue').innerText = currentLineHeight;
        applyFontAndLineHeight();
        saveGlobalConfig();
    }

    // 抽屉外遮罩点击关闭
    drawerOverlay.addEventListener('click', closeDrawer);

    // 底部栏控制
    document.getElementById('actionUpload').addEventListener('click', () => {
        const fileInput = document.getElementById('fileInputMobile');
        fileInput.click();
        bottomBar.classList.remove('visible');
    });

    document.getElementById('fileInputMobile').addEventListener('change', (e) => {
        if(e.target.files.length) processFile(e.target.files[0]);
    });

    document.getElementById('actionToc').addEventListener('click', () => {
        openDrawer();
        bottomBar.classList.remove('visible');
    });

    document.getElementById('actionTheme').addEventListener('click', () => {
        setTheme(currentTheme === 'light' ? 'dark' : 'light');
        bottomBar.classList.remove('visible');
    });

    document.getElementById('actionFont').addEventListener('click', () => {
        const panel = document.getElementById('fontPanel');
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    document.getElementById('actionSearch').addEventListener('click', () => {
        openSearchPanel();
        bottomBar.classList.remove('visible');
    });

    document.getElementById('actionNav').addEventListener('click', () => {
        // 导航功能: 弹出章节导航（如果智能章节模式可用）
        if(currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            chapterNavMobile.style.display = 'flex';
            setTimeout(() => {
                chapterNavMobile.style.display = 'none';
            }, 3000);
        }
        bottomBar.classList.remove('visible');
    });

    // 字号按钮
    document.querySelector('.font-minus')?.addEventListener('click', () => adjustFontSize(-10));
    document.querySelector('.font-plus')?.addEventListener('click', () => adjustFontSize(10));
    document.getElementById('lineHeightSlider')?.addEventListener('input', (e) => setLineHeight(e.target.value));

    // 搜索面板
    document.getElementById('searchHeaderBtn').addEventListener('click', openSearchPanel);
    document.getElementById('closeSearchPanel').addEventListener('click', closeSearchPanel);
    mobileSearchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            performSearch(mobileSearchInput.value);
        }, 300);
    });

    // 更多菜单
    document.getElementById('moreMenuBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMoreMenu();
    });
    document.addEventListener('click', () => {
        moreMenu.style.display = 'none';
    });
    moreMenu.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('menuUrlImport').addEventListener('click', () => {
        urlModal.style.display = 'flex';
        moreMenu.style.display = 'none';
    });

    document.getElementById('menuSmartChapter').addEventListener('click', () => {
        if(currentBookType === 'txt') toggleSmartChapterMode();
        moreMenu.style.display = 'none';
    });

    document.getElementById('menuProgress').addEventListener('click', () => {
        alert('阅读进度已自动保存');
        moreMenu.style.display = 'none';
    });

    // URL Modal
    document.getElementById('confirmUrlBtn').addEventListener('click', () => {
        const url = document.getElementById('bookUrlMobile').value;
        loadFromUrl(url);
    });
    document.getElementById('cancelUrlBtn').addEventListener('click', () => {
        urlModal.style.display = 'none';
    });

    // 菜单开关
    document.getElementById('menuToggleBtn').addEventListener('click', openDrawer);
    document.getElementById('closeDrawer').addEventListener('click', closeDrawer);

    // 章节导航按钮
    document.getElementById('prevChapterMobile').addEventListener('click', () => {
        if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex-1);
    });
    document.getElementById('nextChapterMobile').addEventListener('click', () => {
        if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex+1);
    });

    // 拖拽上传
    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', async e => {
        e.preventDefault();
        const f = e.dataTransfer.files;
        if(f.length) await processFile(f[0]);
    });

    // 初始化
    loadGlobalConfig();
    // 恢复上次阅读
    (async () => {
        const cfg = loadGlobalConfig();
        if(cfg.lastBookId) {
            const bookRecord = await loadBookFromIndexedDB(cfg.lastBookId);
            if(bookRecord && bookRecord.blob) {
                const file = new File([bookRecord.blob], bookRecord.fileName, { type: `application/${bookRecord.fileType}` });
                await processFile(file);
            }
        }
    })();

    window.addEventListener('beforeunload', () => saveProgress());
})();
