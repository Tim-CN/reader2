// script.js - 完整阅读器逻辑（支持 TXT 自动编码检测 + 全文搜索）
(function(){
    // ---------- 全局变量 ----------
    let currentBookType = null;   // 'epub', 'pdf', 'txt'
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
    let currentSearchMatches = [];        // 本地匹配列表 { start, end, text }
    let currentActiveMatchIndex = -1;
    let searchPendingChapter = null;     // 待跳转的章节索引与匹配索引

    // DOM 元素
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
    const chapterInfoSpan = document.getElementById('chapterInfo');
    const loadingToast = document.getElementById('loadingToast');

    // 搜索 DOM
    const searchBtn = document.getElementById('searchBtn');
    const searchPanel = document.getElementById('searchPanel');
    const searchInput = document.getElementById('searchInput');
    const closeSearchBtn = document.getElementById('closeSearchBtn');
    const localMatchList = document.getElementById('localMatchList');
    const globalMatchList = document.getElementById('globalMatchList');

    // 辅助函数
    function showLoading(show, text = "加载中...") {
        if(show) {
            loadingToast.innerText = text;
            loadingToast.style.display = "block";
        } else {
            loadingToast.style.display = "none";
        }
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

    // 全局配置
    function saveGlobalConfig() {
        const config = {
            fontSize: currentFontSize,
            theme: currentTheme,
            lastBookId: currentBookUrlOrId,
            lastBookType: currentBookType,
            lastFileName: currentFileName
        };
        localStorage.setItem("zzx_reader_config", JSON.stringify(config));
    }

    function loadGlobalConfig() {
        const raw = localStorage.getItem("zzx_reader_config");
        if(raw) {
            try {
                const cfg = JSON.parse(raw);
                currentFontSize = cfg.fontSize || 100;
                currentTheme = cfg.theme || "light";
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
        let progressData = { type: currentBookType };
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
            progressData.smartMode = smartChapterMode;
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

    // 自动检测编码
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
            } catch (e) { continue; }
        }
        return bestEncoding;
    }

    // 智能章节分割（自适应单位）
    function splitIntelligentChapters(text) {
        // 统计所有候选单位
        const unitCounter = {};
        const pattern = /^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])\s*/gm;
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

        // 构建分割正则
        let splitPattern;
        if (bestUnit) {
            splitPattern = new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`, 'gm');
        } else {
            // 没有常见单位时，尝试通用匹配
            splitPattern = /^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        }

        const lines = text.split(/\r?\n/);
        const chapters = [];
        let currentTitle = "序言";
        let currentContent = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            // 重置 lastIndex
            splitPattern.lastIndex = 0;
            if (splitPattern.test(trimmed) && trimmed.length < 50) {
                if (currentContent.length > 0) {
                    chapters.push({ title: currentTitle, content: currentContent.join('\n') });
                }
                currentTitle = trimmed;
                currentContent = [];
            } else {
                currentContent.push(line);
            }
        }
        if (currentContent.length > 0) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
        if (chapters.length === 0) chapters = [{ title: "全文", content: text }];
        return chapters;
    }

    async function renderTxtChapter(index) {
        if(!currentTxtChunks.length) return;
        currentChapterIndex = Math.min(index, currentTxtChunks.length-1);
        currentChapterIndex = Math.max(0, currentChapterIndex);
        const chapter = currentTxtChunks[currentChapterIndex];
        const htmlContent = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"><h3 style="margin-bottom:1rem;">${escapeHtml(chapter.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(chapter.content)}</div></div>`;
        readerArea.innerHTML = htmlContent;
        updateTocForSmartChapters();
        chapterInfoSpan.innerText = `${currentChapterIndex+1} / ${currentTxtChunks.length} · ${chapter.title}`;
        chapterNavBar.style.display = 'flex';
        readerContainer.scrollTop = 0;
        // 如果搜索词存在，自动高亮并可能跳转
        if (currentSearchTerm) {
            performSearch(currentSearchTerm);
            if (searchPendingChapter && searchPendingChapter.chapterIndex === currentChapterIndex) {
                // 跳转到指定匹配项
                setTimeout(() => {
                    highlightAndScrollToMatch(searchPendingChapter.matchIndex);
                    searchPendingChapter = null;
                }, 50);
            }
        }
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if(!smartChapterMode || !currentTxtChunks.length) return;
        tocListEl.innerHTML = '';
        const ul = document.createElement('ul');
        ul.className = 'toc-list';
        currentTxtChunks.forEach((ch, idx) => {
            const li = document.createElement('li');
            li.className = 'toc-item';
            if(idx === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length>30? ch.title.slice(0,28)+'...' : ch.title;
            li.addEventListener('click', () => renderTxtChapter(idx));
            ul.appendChild(li);
        });
        tocListEl.appendChild(ul);
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
            } else {
                saveProgress();
            }
        }
        renderNextChunk();
    }

    function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }

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
        if(smartChapterMode && currentTxtChunks.length > 0) {
            await renderTxtChapter(0);
        } else {
            await renderFullTxtLazy();
            chapterNavBar.style.display = 'none';
            buildTxtSimpleToc();
        }
        bindScrollSave();
        await loadProgressForCurrent();
        if(currentSearchTerm) performSearch(currentSearchTerm);
    }

    function buildTxtSimpleToc() {
        tocListEl.innerHTML = '<li class="toc-item">纯文本模式 · 无智能目录</li><li class="toc-item" style="color:#3b82f6" id="enableSmartBtnToc">🔍 开启智能章节</li>';
        const enableBtn = document.getElementById('enableSmartBtnToc');
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
            chapterNavBar.style.display = 'none';
            buildTxtSimpleToc();
        }
        saveProgress();
    }

    function updateSmartChapterUI() {
        if(currentBookType === 'txt') {
            if(smartChapterMode) smartChapterBtn.classList.add('smart-chapter-active');
            else smartChapterBtn.classList.remove('smart-chapter-active');
        } else {
            smartChapterBtn.classList.remove('smart-chapter-active');
        }
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
        } catch(e){ showLoading(false); readerArea.innerHTML=`<div class="empty-state">EPUB解析失败</div>`; }
    }
    
    function buildEpubToc(toc){ 
        tocListEl.innerHTML=''; const ul=document.createElement('ul'); 
        const render=(items,parentUl)=>{ items.forEach(item=>{ const li=document.createElement('li'); li.className='toc-item'; li.innerText=item.label||'章节'; if(item.href) li.addEventListener('click',()=>currentRendition.display(item.href)); parentUl.appendChild(li); if(item.subitems) render(item.subitems,parentUl); }); }; 
        render(toc,ul); tocListEl.appendChild(ul);
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
        for(let i=1;i<=currentPdfTotalPages;i++){ const li=document.createElement('li'); li.className='toc-item'; li.innerText=`第 ${i} 页`; li.addEventListener('click',()=>renderPdfPage(i,true)); ul.appendChild(li); }
        tocListEl.appendChild(ul);
    }
    
    function clearReader(){
        if(currentRendition) try{currentRendition.destroy();}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy();}catch(e){}
        currentPdfDoc=null; currentTxtRaw=null; currentTxtChunks=[];
        readerArea.innerHTML=''; currentBookType=null; tocListEl.innerHTML='<li style="padding:20px;text-align:center;">暂无目录</li>';
        chapterNavBar.style.display='none';
        // 清除搜索
        clearSearch();
    }
    
    function bindScrollSave(){
        const handler=()=>{ saveProgress(); };
        let saveTimer=null;
        readerContainer.addEventListener('scroll', ()=>{ if(saveTimer) clearTimeout(saveTimer); saveTimer=setTimeout(handler,600); });
    }
    
    function setTheme(theme){ 
        currentTheme=theme; 
        if(theme==='dark') document.body.classList.add('dark'); 
        else document.body.classList.remove('dark'); 
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.select(theme); 
        else if(currentBookType==='txt'){ const tv=document.querySelector('.txt-viewer'); if(tv) tv.style.color=theme==='dark'?'#e2e8f0':'#1e293b'; } 
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
        }catch(err){ alert("加载失败:"+err.message); } finally{ showLoading(false); }
    }

    function initDragAndDrop(){ 
        document.body.addEventListener('dragover',e=>e.preventDefault()); 
        document.body.addEventListener('drop',async e=>{ e.preventDefault(); const f=e.dataTransfer.files; if(f.length) await processFile(f[0]); }); 
    }
    
    // ========== 全文搜索功能 ==========
    function clearSearch() {
        currentSearchTerm = "";
        currentSearchMatches = [];
        currentActiveMatchIndex = -1;
        searchPendingChapter = null;
        if (searchInput) searchInput.value = "";
        if (localMatchList) localMatchList.innerHTML = "";
        if (globalMatchList) globalMatchList.innerHTML = "";
        removeHighlights();
    }

    function openSearchPanel() {
        searchPanel.style.display = 'block';
        searchInput.focus();
        if (currentSearchTerm) {
            searchInput.value = currentSearchTerm;
            performSearch(currentSearchTerm);
        }
    }

    function closeSearchPanel() {
        searchPanel.style.display = 'none';
        clearSearch();
    }

    // 获取当前视图的文本内容（用于本地搜索）
    function getCurrentVisibleText() {
        if (currentBookType === 'txt') {
            if (smartChapterMode && currentTxtChunks.length) {
                return currentTxtChunks[currentChapterIndex].content;
            } else {
                return currentTxtRaw || "";
            }
        } else if (currentBookType === 'epub') {
            // 尝试从 iframe 获取文本，但可能跨域；简单粗暴：获取 readerArea 内部文本
            return readerArea.innerText || "";
        } else if (currentBookType === 'pdf') {
            return readerArea.innerText || "";
        }
        return "";
    }

    // 全文搜索（跨章节）
    function searchGlobal(query) {
        if (!query) return [];
        const results = [];
        const lowerQuery = query.toLowerCase();
        if (currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, idx) => {
                const content = ch.content;
                let count = 0;
                let pos = content.toLowerCase().indexOf(lowerQuery);
                while (pos !== -1) {
                    count++;
                    pos = content.toLowerCase().indexOf(lowerQuery, pos + 1);
                }
                if (count > 0) {
                    results.push({ chapterIndex: idx, title: ch.title, count });
                }
            });
        } else if (currentBookType === 'epub' && currentRendition) {
            // 使用 epub.js 内置搜索
            return null; // 将在 performSearch 中异步处理
        } else if (currentBookType === 'txt') {
            // 非智能模式，全文算一章
            const count = (currentTxtRaw || "").toLowerCase().split(lowerQuery).length - 1;
            if (count > 0) results.push({ chapterIndex: 0, title: "全文", count });
        } else if (currentBookType === 'pdf') {
            return []; // 暂不支持
        }
        return results;
    }

    async function performEpubSearch(query) {
        if (!currentRendition) return;
        try {
            const results = await currentRendition.search(query);
            return results.map(item => ({
                cfi: item.cfi,
                excerpt: item.excerpt || ""
            }));
        } catch (e) {
            return [];
        }
    }

    async function performSearch(query) {
        currentSearchTerm = query;
        if (!query.trim()) {
            localMatchList.innerHTML = "";
            globalMatchList.innerHTML = "";
            removeHighlights();
            return;
        }
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
        currentActiveMatchIndex = localMatches.length > 0 ? 0 : -1;

        // 渲染本地结果
        localMatchList.innerHTML = localMatches.length 
            ? localMatches.map((m, i) => `<li data-match-index="${i}">...${escapeHtml(m.text)}...</li>`).join('')
            : '<li>无匹配</li>';

        // 全文搜索
        if (currentBookType === 'epub') {
            const epubResults = await performEpubSearch(query);
            if (epubResults && epubResults.length) {
                globalMatchList.innerHTML = epubResults.map((r, i) => `<li data-epub-index="${i}" data-cfi="${r.cfi}">${escapeHtml(r.excerpt)}</li>`).join('');
            } else {
                globalMatchList.innerHTML = '<li>全文无匹配</li>';
            }
        } else {
            const globalResults = searchGlobal(query);
            if (globalResults && globalResults.length) {
                globalMatchList.innerHTML = globalResults.map(r => {
                    if (r.chapterIndex !== undefined) {
                        return `<li data-chapter-index="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count}个匹配)</li>`;
                    } else {
                        return `<li>${escapeHtml(r.title)} (${r.count}个匹配)</li>`;
                    }
                }).join('');
            } else {
                globalMatchList.innerHTML = '<li>全文无匹配</li>';
            }
        }

        // 高亮当前视图
        highlightLocalMatches();
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
        } else if (currentBookType === 'epub') {
            // epub 的 iframe 内容我们无法直接修改，故跳过
            return null;
        }
        return null;
    }

    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlightAndScrollToMatch(matchIndex) {
        if (matchIndex < 0 || matchIndex >= currentSearchMatches.length) return;
        currentActiveMatchIndex = matchIndex;
        const container = getTextViewContainer();
        if (!container) return;
        const marks = container.querySelectorAll('mark');
        if (marks.length > matchIndex) {
            marks[matchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 添加视觉反馈
            marks.forEach(m => m.style.background = '');
            marks[matchIndex].style.background = '#f97316';
        }
    }

    // 事件绑定：本地搜索结果点击
    localMatchList.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        const matchIndex = parseInt(li.dataset.matchIndex, 10);
        if (!isNaN(matchIndex)) {
            highlightAndScrollToMatch(matchIndex);
        }
    });

    // 全文搜索结果点击
    globalMatchList.addEventListener('click', async (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        if (currentBookType === 'epub') {
            const cfi = li.dataset.cfi;
            if (cfi && currentRendition) {
                await currentRendition.display(cfi);
                // 重新搜索以更新本地结果
                setTimeout(() => performSearch(currentSearchTerm), 300);
            }
        } else if (currentBookType === 'txt') {
            const chapterIdx = parseInt(li.dataset.chapterIndex, 10);
            if (!isNaN(chapterIdx) && currentTxtChunks.length) {
                if (chapterIdx !== currentChapterIndex) {
                    searchPendingChapter = { chapterIndex: chapterIdx, matchIndex: 0 };
                    await renderTxtChapter(chapterIdx);
                } else {
                    highlightAndScrollToMatch(0);
                }
            }
        }
    });

    // 搜索输入实时触发
    let searchDebounceTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        const query = searchInput.value;
        searchDebounceTimer = setTimeout(() => performSearch(query), 300);
    });

    searchBtn.addEventListener('click', openSearchPanel);
    closeSearchBtn.addEventListener('click', closeSearchPanel);
    // 点击搜索面板外部关闭 (简单处理：点击 readerContainer 其他区域不关闭，只有按钮关闭)

    // 原有事件绑定
    fileInput.addEventListener('change', e=>{ if(e.target.files.length) processFile(e.target.files[0]); fileInput.value=''; });
    loadUrlBtn.addEventListener('click',()=>loadFromUrl(bookUrlInput.value));
    toggleSidebarBtn.addEventListener('click',()=>{ isSidebarVisible=!isSidebarVisible; sidebar.classList.toggle('hide',!isSidebarVisible); });
    themeToggleBtn.addEventListener('click',()=>setTheme(currentTheme==='light'?'dark':'light'));
    fontPlusBtn.addEventListener('click',()=>adjustFontSize(10));
    fontMinusBtn.addEventListener('click',()=>adjustFontSize(-10));
    smartChapterBtn.addEventListener('click',()=>{ if(currentBookType==='txt') toggleSmartChapterMode(); });
    prevChapterBtn.addEventListener('click',()=>{ if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex-1); });
    nextChapterBtn.addEventListener('click',()=>{ if(smartChapterMode && currentTxtChunks.length) renderTxtChapter(currentChapterIndex+1); });
    window.addEventListener('beforeunload',()=>saveProgress());
    initDragAndDrop();
    loadGlobalConfig();
    
    // 恢复上次书本
    (async ()=>{
        const cfg=loadGlobalConfig();
        if(cfg.lastBookId){
            const bookRecord = await loadBookFromIndexedDB(cfg.lastBookId);
            if(bookRecord && bookRecord.blob){
                const fileBlob = bookRecord.blob;
                const file = new File([fileBlob], bookRecord.fileName, {type:`application/${bookRecord.fileType}`});
                await processFile(file);
            }
        }
    })();
})();
