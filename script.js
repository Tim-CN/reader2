// script.js - 完整阅读器逻辑（支持 TXT 自动编码检测）
(function(){
    // ---------- 全局变量 ----------
    let currentBookType = null;   // 'epub', 'pdf', 'txt'
    let currentEpubBook = null;
    let currentRendition = null;
    let currentPdfDoc = null;
    let currentPdfTotalPages = 0;
    let currentPdfPageNum = 1;
    let currentTxtRaw = null;          // 原始文本
    let currentTxtChunks = [];          // 智能分割后的章节 {title, content}
    let smartChapterMode = false;       // 是否开启智能章节模式
    let currentChapterIndex = 0;
    let currentFileName = "";
    let currentFontSize = 100;
    let currentTheme = "light";
    let isSidebarVisible = true;
    let currentBookUrlOrId = "";        // 用于保存书本标识: 文件名或url

    // IndexedDB 存储文件内容（持久化）
    let db = null;
    const DB_NAME = "ZZXReaderDB";
    const STORE_NAME = "books";

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

    // 辅助函数
    function showLoading(show, text = "加载中...") {
        if(show) {
            loadingToast.innerText = text;
            loadingToast.style.display = "block";
        } else {
            loadingToast.style.display = "none";
        }
    }

    // 初始化 IndexedDB
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

    // 保存全局配置 (字号，主题，最近书本标识)
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
                adjustFontSize(0); // 应用字号
                return cfg;
            } catch(e) {}
        }
        return {};
    }

    // 保存进度
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

    // ========== 新增：自动检测文本编码 ==========
    /**
     * 自动检测 ArrayBuffer 的文本编码
     * @param {ArrayBuffer} buffer 文件数据
     * @param {number} sampleSize 用于检测的字节数（默认 4096）
     * @returns {string} 检测到的编码名称，如 'utf-8', 'gbk', 'big5'
     */
    async function detectEncoding(buffer, sampleSize = 4096) {
        // 常见编码列表（按优先级排列）
        const encodings = ['utf-8', 'gbk', 'gb2312', 'big5', 'shift-jis', 'euc-kr'];
        const sample = buffer.slice(0, sampleSize);
        
        // 计算字符串中“好字符”的比例
        function scoreText(text) {
            let validChars = 0;
            for (let i = 0; i < text.length && i < 1000; i++) {
                const code = text.charCodeAt(i);
                // 中文字符范围 (基本汉字)
                if ((code >= 0x4E00 && code <= 0x9FFF) ||
                    // 日文假名、韩文等常用范围（粗略）
                    (code >= 0x3040 && code <= 0x30FF) ||
                    (code >= 0xAC00 && code <= 0xD7AF) ||
                    // 字母、数字、常用标点
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
                // 如果得分极高（>0.95），提前结束
                if (bestScore > 0.95) break;
            } catch (e) {
                // 某些编码可能不被浏览器支持，跳过
                continue;
            }
        }
        return bestEncoding;
    }

    // 智能章节分割 (正则匹配)
    function splitIntelligentChapters(text) {
        const chapterPattern = /^(?:第[零一二三四五六七八九十百千万0-9]+[章节卷回]|第[0-9]+[章节卷回]|[卷][零一二三四五六七八九十百千万0-9]+|第[0-9]+[\.\、]?|[一二三四五六七八九十]+[、\.\s]章?)/gm;
        const lines = text.split(/\r?\n/);
        let chapters = [];
        let currentTitle = "序言";
        let currentContent = [];
        for(let line of lines) {
            if(chapterPattern.test(line.trim()) && line.length < 40) {
                if(currentContent.length) {
                    chapters.push({ title: currentTitle, content: currentContent.join('\n') });
                }
                currentTitle = line.trim();
                currentContent = [];
            } else {
                currentContent.push(line);
            }
        }
        if(currentContent.length) chapters.push({ title: currentTitle, content: currentContent.join('\n') });
        if(chapters.length === 0) chapters = [{ title: "全文", content: text }];
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
        // 分块渲染避免卡顿 (6MB分段插入)
        const chunkSize = 50000;
        let index = 0;
        function renderNextChunk() {
            const nextChunk = currentTxtRaw.slice(index, index+chunkSize);
            if(nextChunk) {
                const textNode = document.createTextNode(nextChunk);
                containerDiv.appendChild(textNode);
                index += chunkSize;
                requestAnimationFrame(() => { if(index < currentTxtRaw.length) renderNextChunk(); else saveProgress(); });
            } else {
                saveProgress();
            }
        }
        renderNextChunk();
    }

    function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }

    // 修改后的 loadTxtSmartOrPlain：加入自动编码检测
    async function loadTxtSmartOrPlain(arrayBuffer, filename) {
        clearReader();
        currentBookType = 'txt';
        currentFileName = filename;

        // 自动检测编码
        const encoding = await detectEncoding(arrayBuffer);
        console.log(`检测到文本编码：${encoding}`);
        const decoder = new TextDecoder(encoding);
        currentTxtRaw = decoder.decode(arrayBuffer);

        // 智能分割
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
        // 简单监听滚动保存页码
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
    
    // 事件绑定
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
    
    // 尝试恢复上次阅读的书本
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
