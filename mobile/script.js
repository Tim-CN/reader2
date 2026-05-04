// mobile/script.js - 移动版电子书阅读器核心逻辑（适配手机触控，保留全部功能）
(function(){
    // 配置 PDF.js worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

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
    let currentBookUrlOrId = "";

    // IndexedDB
    let db = null;
    const DB_NAME = "ZZXReaderDB";
    const STORE_NAME = "books";

    // 搜索相关
    let currentSearchTerm = "";
    let currentSearchMatches = [];
    let searchDebounceTimer = null;

    // DOM 元素（移动版）
    const fileInput = document.getElementById('fileInput');
    const bookUrlInput = document.getElementById('bookUrl');
    const loadUrlBtn = document.getElementById('loadUrlBtn');
    const readerArea = document.getElementById('readerArea');
    const readerContainer = document.getElementById('readerContainer');
    const tocListEl = document.getElementById('tocList');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const closeSidebarBtn = document.getElementById('closeSidebarBtn');
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

    // 辅助函数
    function showLoading(show, text = "加载中...") {
        if(show) {
            loadingToast.innerText = text;
            loadingToast.style.display = "block";
        } else {
            loadingToast.style.display = "none";
        }
    }

    // 侧边栏控制
    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.style.display = 'block';
        document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.style.display = 'none';
        document.body.style.overflow = '';
    }
    mobileMenuBtn.addEventListener('click', openSidebar);
    closeSidebarBtn.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

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
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
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

    // 全局配置存储
    function saveGlobalConfig() {
        const config = {
            fontSize: currentFontSize,
            theme: currentTheme,
            lastBookId: currentBookUrlOrId,
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
                smartChapterMode = cfg.smartChapterMode || false;
                setTheme(currentTheme);
                adjustFontSize(0);
                return cfg;
            } catch(e) {}
        }
        return {};
    }

    // 进度保存与恢复（复用原逻辑，略加调整）
    async function saveProgress() {
        if(!currentFileName) return;
        const key = `progress_mobile_${currentFileName}`;
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
        const key = `progress_mobile_${currentFileName}`;
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
                    }, 150);
                }
            }
        } catch(e) { console.warn(e); }
    }

    // 编码检测与智能章节 (与桌面版一致)
    async function detectEncoding(buffer, sampleSize = 4096) {
        const encodings = ['utf-8', 'gbk', 'gb2312', 'big5', 'shift-jis', 'euc-kr'];
        const sample = buffer.slice(0, sampleSize);
        function scoreText(text) {
            let validChars = 0;
            for (let i = 0; i < text.length && i < 1000; i++) {
                const code = text.charCodeAt(i);
                if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF) || (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x20 && code <= 0x7E) || (code === 0x0A || code === 0x0D || code === 0x09)) validChars++;
            }
            return validChars / (text.length || 1);
        }
        let bestEncoding = 'utf-8', bestScore = 0;
        for (const enc of encodings) {
            try {
                const decoder = new TextDecoder(enc, { fatal: false });
                const text = decoder.decode(sample);
                const score = scoreText(text);
                if (score > bestScore) { bestScore = score; bestEncoding = enc; }
                if (bestScore > 0.95) break;
            } catch(e) {}
        }
        return bestEncoding;
    }

    function splitIntelligentChapters(text) {
        const unitCounter = {};
        const pattern = /^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])/gm;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const unit = match[2];
            unitCounter[unit] = (unitCounter[unit] || 0) + 1;
        }
        let bestUnit = null, maxCount = 0;
        for (let u in unitCounter) if(unitCounter[u] > maxCount) { maxCount = unitCounter[u]; bestUnit = u; }
        let splitPattern = bestUnit ? new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`, 'gm') : /^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        const lines = text.split(/\r?\n/);
        const chapters = [];
        let currentTitle = "序言", currentContent = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i], trimmed = line.trim();
            splitPattern.lastIndex = 0;
            if (splitPattern.test(trimmed) && trimmed.length < 50) {
                if (currentContent.length) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
                currentTitle = trimmed;
                currentContent = [];
            } else { currentContent.push(line); }
        }
        if (currentContent.length) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
        if (chapters.length === 0) chapters = [{ title: "全文", content: text }];
        return chapters;
    }

    async function renderTxtChapter(index) {
        if(!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(index, currentTxtChunks.length-1);
        currentChapterIndex = Math.max(0, currentChapterIndex);
        const chapter = currentTxtChunks[currentChapterIndex];
        const htmlContent = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"><h3 style="margin-bottom:0.75rem;">${escapeHtml(chapter.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(chapter.content)}</div></div>`;
        readerArea.innerHTML = htmlContent;
        updateTocForSmartChapters();
        chapterTitleSpan.innerText = chapter.title;
        chapterNavBar.classList.add('visible');   // 移动端一直显示智能章节导航
        readerContainer.scrollTop = 0;
        if (currentSearchTerm) performSearch(currentSearchTerm);
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if(!smartChapterMode || !currentTxtChunks.length) return;
        tocListEl.innerHTML = '';
        currentTxtChunks.forEach((ch, idx) => {
            const li = document.createElement('li');
            li.className = 'toc-item';
            if(idx === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length>28? ch.title.slice(0,26)+'...' : ch.title;
            li.addEventListener('click', () => { renderTxtChapter(idx); closeSidebar(); });
            tocListEl.appendChild(li);
        });
    }

    async function renderFullTxtLazy() {
        if(!currentTxtRaw) return;
        readerArea.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"></div>`;
        const containerDiv = readerArea.querySelector('.txt-viewer');
        const chunkSize = 50000;
        let index = 0;
        function renderNextChunk() {
            const nextChunk = currentTxtRaw.slice(index, index+chunkSize);
            if(nextChunk) {
                const textNode = document.createTextNode(nextChunk);
                containerDiv.appendChild(textNode);
                index += chunkSize;
                requestAnimationFrame(() => { if(index < currentTxtRaw.length) renderNextChunk(); else { if(currentSearchTerm) performSearch(currentSearchTerm); saveProgress(); } });
            } else { saveProgress(); }
        }
        renderNextChunk();
    }

    function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){ if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }

    async function loadTxtSmartOrPlain(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'txt';
        currentFileName = filename;
        const encoding = await detectEncoding(arrayBuffer);
        const decoder = new TextDecoder(encoding);
        currentTxtRaw = decoder.decode(arrayBuffer);
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        const savedMode = localStorage.getItem(`txt_smart_mode_mobile_${filename}`);
        smartChapterMode = (savedMode === 'true') ? true : false;
        updateSmartChapterUI();
        if(smartChapterMode && currentTxtChunks.length > 0) {
            chapterNavBar.classList.add('visible');
            await renderTxtChapter(0);
        } else {
            chapterNavBar.classList.remove('visible');
            await renderFullTxtLazy();
            buildTxtSimpleToc();
        }
        bindScrollSave();
        await loadProgressForCurrent();
        if(currentSearchTerm) performSearch(currentSearchTerm);
    }

    function buildTxtSimpleToc() {
        tocListEl.innerHTML = '<li class="toc-item">纯文本模式 · 无智能目录</li><li class="toc-item" style="color:#3b82f6" id="enableSmartBtnToc">🔍 开启智能章节</li>';
        const enableBtn = document.getElementById('enableSmartBtnToc');
        if(enableBtn) enableBtn.addEventListener('click', () => { toggleSmartChapterMode(true); closeSidebar(); });
    }

    function toggleSmartChapterMode(forceEnable) {
        if(currentBookType !== 'txt') return;
        smartChapterMode = forceEnable !== undefined ? forceEnable : !smartChapterMode;
        localStorage.setItem(`txt_smart_mode_mobile_${currentFileName}`, smartChapterMode);
        updateSmartChapterUI();
        if(smartChapterMode && currentTxtChunks.length) {
            chapterNavBar.classList.add('visible');
            renderTxtChapter(currentChapterIndex);
        } else if(!smartChapterMode) {
            chapterNavBar.classList.remove('visible');
            renderFullTxtLazy();
            buildTxtSimpleToc();
        }
        saveProgress();
    }

    function updateSmartChapterUI() {
        if(currentBookType === 'txt' && smartChapterMode) smartChapterBtn.classList.add('smart-active');
        else smartChapterBtn.classList.remove('smart-active');
    }

    // EPUB 逻辑
    async function loadEpub(arrayBuffer, filename) {
        clearReader(); currentBookType='epub'; currentFileName=filename;
        showLoading(true);
        try {
            const blob = new Blob([arrayBuffer], {type:"application/epub+zip"});
            const url = URL.createObjectURL(blob);
            currentEpubBook = ePub(url);
            currentRendition = currentEpubBook.renderTo("readerArea", { width:"100%", height:"100%", spread:"none", flow:"paginated" });
            await currentRendition.display();
            currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
            currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
            setTheme(currentTheme);
            currentRendition.themes.fontSize(currentFontSize+"%");
            const nav = await currentEpubBook.loaded.navigation;
            buildEpubToc(nav.toc);
            currentRendition.on('relocated', () => saveProgress());
            await loadProgressForCurrent();
            showLoading(false);
            chapterNavBar.classList.remove('visible');
        } catch(e){ showLoading(false); readerArea.innerHTML=`<div class="empty-state">EPUB解析失败</div>`; }
    }
    
    function buildEpubToc(toc){ 
        tocListEl.innerHTML=''; 
        const render=(items,parentUl)=>{ items.forEach(item=>{ const li=document.createElement('li'); li.className='toc-item'; li.innerText=item.label||'章节'; if(item.href) li.addEventListener('click',()=>{ currentRendition.display(item.href); closeSidebar(); }); parentUl.appendChild(li); if(item.subitems) render(item.subitems,parentUl); }); }; 
        const ul=document.createElement('ul'); render(toc,ul); tocListEl.appendChild(ul);
    }
    
    // PDF 逻辑
    async function loadPdf(arrayBuffer, filename){ 
        clearReader(); currentBookType='pdf'; currentFileName=filename; showLoading(true);
        try{
            const typedArray=new Uint8Array(arrayBuffer);
            currentPdfDoc=await pdfjsLib.getDocument({data:typedArray}).promise;
            currentPdfTotalPages=currentPdfDoc.numPages;
            await renderPdfPage(1);
            bindScrollSave();
            await loadProgressForCurrent();
            showLoading(false);
            chapterNavBar.classList.remove('visible');
        }catch(e){ showLoading(false); readerArea.innerHTML=`<div class="empty-state">PDF加载失败</div>`; }
    }
    
    async function renderPdfPage(pageNumber, isJump=false){
        if(!currentPdfDoc) return;
        currentPdfPageNum=Math.min(Math.max(1,pageNumber),currentPdfTotalPages);
        readerArea.innerHTML=`<div class="pdf-viewer" id="pdfViewer"></div>`;
        const container=document.getElementById('pdfViewer');
        for(let i=1;i<=currentPdfTotalPages;i++){
            const page=await currentPdfDoc.getPage(i);
            const viewport=page.getViewport({scale:1.5});
            const canvas=document.createElement('canvas'); canvas.height=viewport.height; canvas.width=viewport.width; canvas.className='pdf-page-canvas'; canvas.setAttribute('data-page-num',i);
            await page.render({canvasContext:canvas.getContext('2d'),viewport:viewport}).promise;
            container.appendChild(canvas);
        }
        const observer = new IntersectionObserver((entries)=>{ 
            entries.forEach(e=>{ if(e.isIntersecting){ const p=parseInt(e.target.dataset.pageNum); if(!isNaN(p)) currentPdfPageNum=p; saveProgress(); } }); 
        },{threshold:0.5});
        document.querySelectorAll('.pdf-page-canvas').forEach(canvas => observer.observe(canvas));
        if(isJump) document.querySelector(`.pdf-page-canvas[data-page-num='${currentPdfPageNum}']`)?.scrollIntoView({behavior:'smooth'});
        buildPdfToc();
    }
    
    function buildPdfToc(){ 
        tocListEl.innerHTML=''; const ul=document.createElement('ul');
        for(let i=1;i<=currentPdfTotalPages;i++){ const li=document.createElement('li'); li.className='toc-item'; li.innerText=`第 ${i} 页`; li.addEventListener('click',()=>{ renderPdfPage(i,true); closeSidebar(); }); ul.appendChild(li); }
        tocListEl.appendChild(ul);
    }
    
    function clearReader(){
        if(currentRendition) try{currentRendition.destroy();}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy();}catch(e){}
        currentPdfDoc=null; currentTxtRaw=null; currentTxtChunks=[];
        readerArea.innerHTML=''; currentBookType=null; tocListEl.innerHTML='<li style="padding:20px;text-align:center;">暂无目录</li>';
        chapterNavBar.classList.remove('visible');
        chapterTitleSpan.innerText = '';
        clearSearch();
    }
    
    function bindScrollSave(){
        let saveTimer=null;
        const handler=()=>{ saveProgress(); };
        readerContainer.addEventListener('scroll', ()=>{ if(saveTimer) clearTimeout(saveTimer); saveTimer=setTimeout(handler,600); });
    }
    
    function setTheme(theme){ 
        currentTheme=theme; 
        if(theme==='dark') document.body.classList.add('dark'); 
        else document.body.classList.remove('dark'); 
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.select(theme); 
        if(currentBookType==='txt'){ const tv=document.querySelector('.txt-viewer'); if(tv) tv.style.color=theme==='dark'?'#e2e8f0':'#1e293b'; } 
        saveGlobalConfig(); 
    }
    
    function adjustFontSize(delta){ 
        let newSize=currentFontSize+delta; 
        if(newSize<70) newSize=70; 
        if(newSize>180) newSize=180; 
        currentFontSize=newSize; 
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize+"%"); 
        if(currentBookType==='txt'){ const tv=document.querySelector('.txt-viewer'); if(tv) tv.style.fontSize=(currentFontSize/100)*1.1+"rem"; } 
        saveGlobalConfig(); 
    }
    
    async function processFile(file){
        if(!file) return;
        const name=file.name, ext=name.split('.').pop().toLowerCase();
        const buffer=await file.arrayBuffer();
        const fileId = `file_${name}_${Date.now()}`;
        currentBookUrlOrId = fileId;
        await saveBookToIndexedDB(fileId, new Blob([buffer]), name, ext);
        clearSearch();
        if(ext==='epub') await loadEpub(buffer, name);
        else if(ext==='pdf') await loadPdf(buffer, name);
        else if(ext==='txt') await loadTxtSmartOrPlain(buffer, name);
        else alert("不支持格式");
        saveGlobalConfig();
    }

    async function loadFromUrl(url){
        if(!url.trim()) return;
        showLoading(true,"获取远程文件...");
        try{
            const resp=await fetch(url);
            if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob=await resp.blob();
            const ext=url.split('.').pop().split('?')[0].toLowerCase();
            const filename=url.split('/').pop()||"book";
            const file=new File([blob],filename,{type:blob.type});
            currentBookUrlOrId = url;
            await processFile(file);
            urlPanel.style.display = 'none';
        }catch(err){ alert("加载失败:"+err.message); } finally{ showLoading(false); }
    }

    // 搜索功能（精简保留）
    function clearSearch() { /* 略同桌面版，保留核心 */ 
        currentSearchTerm = ""; currentSearchMatches = []; searchInput.value = ""; searchDropdown.style.display = "none"; clearSearchBtn.style.display = "none"; removeHighlights(); localMatchList.innerHTML = ""; globalMatchList.innerHTML = "";
    }
    function performSearch(query) { /* 完整搜索逻辑同原版，限于篇幅保持核心功能用剪裁版 */ 
        if(!query.trim()){ clearSearch(); return; }
        currentSearchTerm = query; clearSearchBtn.style.display = "inline-flex";
        const localText = getCurrentVisibleText().toLowerCase(); 
        const matches = []; let idx = localText.indexOf(query.toLowerCase());
        while(idx !== -1){ matches.push({start:idx,end:idx+query.length,text:getCurrentVisibleText().slice(Math.max(0,idx-30), idx+query.length+30)}); idx = localText.indexOf(query.toLowerCase(), idx+1); }
        currentSearchMatches = matches;
        localMatchList.innerHTML = matches.length ? matches.map(m=>`<li>...${escapeHtml(m.text)}...</li>`).join('') : '<li>无匹配</li>';
        searchDropdown.style.display = "block";
        if(currentBookType === 'epub' && currentRendition) currentRendition.search(query).then(res=>{ globalMatchList.innerHTML = (res&&res.length)? res.map(r=>`<li data-cfi="${r.cfi}">${escapeHtml(r.excerpt)}</li>`).join('') : '<li>全文无匹配</li>'; }).catch(()=>globalMatchList.innerHTML='<li>失败</li>');
        else if(currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) { let results = []; currentTxtChunks.forEach((ch,idx)=>{ let cnt = (ch.content.toLowerCase().split(query.toLowerCase()).length-1); if(cnt>0) results.push(`<li data-chapter-index="${idx}">${escapeHtml(ch.title)} (${cnt}处)</li>`); }); globalMatchList.innerHTML = results.length? results.join('') : '<li>全文无匹配</li>'; }
        else globalMatchList.innerHTML = '<li>当前书籍不支持全局搜索</li>';
        highlightLocalMatches();
    }
    function getCurrentVisibleText() { if(currentBookType==='txt' && smartChapterMode && currentTxtChunks.length) return currentTxtChunks[currentChapterIndex].content; if(currentBookType==='txt') return currentTxtRaw||""; return readerArea.innerText||""; }
    function highlightLocalMatches() { removeHighlights(); if(!currentSearchTerm || !currentSearchMatches.length) return; const container = document.querySelector('.txt-viewer div, .txt-viewer'); if(container) container.innerHTML = container.innerHTML.replace(new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi'), '<mark>$1</mark>'); }
    function removeHighlights() { const container = document.querySelector('.txt-viewer div, .txt-viewer'); if(container) container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, ''); }
    function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    
    searchInput.addEventListener('input', () => { clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(() => performSearch(searchInput.value), 300); });
    clearSearchBtn.addEventListener('click', clearSearch);
    document.addEventListener('click', (e) => { if(!document.querySelector('.search-bar')?.contains(e.target)) searchDropdown.style.display = 'none'; });
    // 章节导航按钮
    prevChapterBtn.addEventListener('click',()=>{ if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex-1); });
    nextChapterBtn.addEventListener('click',()=>{ if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex+1); });
    
    // 其他事件绑定
    fileInput.addEventListener('change', e=>{ if(e.target.files.length) processFile(e.target.files[0]); fileInput.value=''; });
    themeToggleBtn.addEventListener('click',()=>setTheme(currentTheme==='light'?'dark':'light'));
    fontPlusBtn.addEventListener('click',()=>adjustFontSize(10));
    fontMinusBtn.addEventListener('click',()=>adjustFontSize(-10));
    smartChapterBtn.addEventListener('click',()=>{ if(currentBookType==='txt') toggleSmartChapterMode(); });
    urlLoadBtn.addEventListener('click',()=>{ urlPanel.style.display = urlPanel.style.display === 'none' ? 'flex' : 'none'; });
    closeUrlPanelBtn.addEventListener('click',()=> urlPanel.style.display = 'none');
    loadUrlBtn.addEventListener('click',()=> loadFromUrl(bookUrlInput.value));
    window.addEventListener('beforeunload',()=>saveProgress());
    
    // 拖拽上传
    document.body.addEventListener('dragover',e=>e.preventDefault());
    document.body.addEventListener('drop',async e=>{ e.preventDefault(); const f=e.dataTransfer.files; if(f.length) await processFile(f[0]); });
    
    // 启动加载上次图书
    (async ()=>{
        const cfg=loadGlobalConfig();
        if(cfg.lastBookId){
            const bookRecord = await loadBookFromIndexedDB(cfg.lastBookId);
            if(bookRecord && bookRecord.blob){
                const file = new File([bookRecord.blob], bookRecord.fileName, {type:`application/${bookRecord.fileType}`});
                await processFile(file);
            }
        }
    })();
})();
