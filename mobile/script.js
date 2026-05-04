(function(){
    // ---------- 基础变量 ----------
    let currentBookType = null;       // 'epub', 'pdf', 'txt'
    let currentEpubBook = null;
    let currentRendition = null;
    let currentPdfDoc = null;
    let currentPdfTotalPages = 0;
    let currentPdfPageNum = 1;
    let currentTxtRaw = null;         // TXT原始文本
    let currentTxtPages = [];         // TXT分页数组
    let currentTxtPageIndex = 0;      // 当前TXT页码
    let smartChapterMode = false;
    let currentTxtChunks = [];        // 智能章节数组
    let currentChapterIndex = 0;      // 当前章节索引
    let currentFileName = "";
    let currentFontSize = 100;
    let currentTheme = "light";
    let currentBookUrlOrId = "";

    // DOM元素
    const readerContainer = document.getElementById('readerContainer');
    const readerArea = document.getElementById('readerArea');
    const pageSlider = document.getElementById('pageSlider');
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

    // 搜索相关
    let currentSearchTerm = "";
    let searchDebounceTimer;

    // 防重复点击
    let isAnimating = false;
    let lastTapTime = 0;

    // IndexedDB
    let db = null;
    const DB_NAME = "ZZXMobileDB";
    const STORE_NAME = "books";

    // ---------- 初始化数据库 ----------
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
            txtPage: currentTxtPageIndex,
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
                smartChapterMode = c.smartMode || false;
                setTheme(currentTheme);
                adjustFontSize(0);
                return c;
            } catch(e) {}
        }
        return {};
    }

    // ---------- 翻页动画控制 ----------
    function slideTo(offsetX) {
        return new Promise(resolve => {
            pageSlider.classList.add('animating');
            pageSlider.style.transform = `translateX(${offsetX}px)`;
            const onEnd = () => {
                pageSlider.removeEventListener('transitionend', onEnd);
                pageSlider.classList.remove('animating');
                resolve();
            };
            pageSlider.addEventListener('transitionend', onEnd);
            // 防止 transitionend 未触发
            setTimeout(() => {
                if(pageSlider.classList.contains('animating')) {
                    pageSlider.classList.remove('animating');
                    resolve();
                }
            }, 400);
        });
    }

    async function goToPage(pageIndex, direction = 0) {
        if(isAnimating) return;
        isAnimating = true;
        const containerWidth = readerContainer.clientWidth;
        // 计算目标偏移量：让页码pageIndex显示在视口中央
        let targetX = -pageIndex * containerWidth;
        
        await slideTo(targetX);
        isAnimating = false;
        // 更新当前页码
        if(currentBookType === 'pdf') currentPdfPageNum = pageIndex + 1;
        else if(currentBookType === 'txt') {
            if(smartChapterMode) currentTxtPageIndex = pageIndex;
            else currentTxtPageIndex = pageIndex;
        }
        // EPUB 由rendition管理，不在此处处理
        saveConfig();
    }

    // ---------- 文本分页（TXT专用） ----------
    function paginateTxtText(text, containerHeight) {
        // 创建一个临时元素测量每页可容纳的文本
        const measureDiv = document.createElement('div');
        measureDiv.style.cssText = `position:absolute;visibility:hidden;width:${readerContainer.clientWidth - 24}px;font:${(currentFontSize/100)*1.1}rem Georgia,Times New Roman,serif;line-height:1.6;white-space:pre-wrap;word-break:break-word;padding:0;`;
        document.body.appendChild(measureDiv);
        
        const pages = [];
        let remaining = text;
        while(remaining.length > 0) {
            // 二分法查找适合一页的字符数
            let low = 0, high = remaining.length;
            let bestFit = 0;
            while(low <= high) {
                const mid = Math.floor((low + high) / 2);
                measureDiv.textContent = remaining.slice(0, mid);
                const h = measureDiv.scrollHeight;
                if(h <= containerHeight) {
                    bestFit = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            if(bestFit === 0) bestFit = 1; // 至少一个字符
            pages.push(remaining.slice(0, bestFit));
            remaining = remaining.slice(bestFit);
        }
        document.body.removeChild(measureDiv);
        return pages.length ? pages : [''];
    }

    async function renderTxtPages() {
        // 重建分页并显示第一页
        if(!currentTxtRaw) return;
        const containerHeight = readerContainer.clientHeight - 24; // 减去padding
        currentTxtPages = paginateTxtText(currentTxtRaw, containerHeight);
        currentTxtPageIndex = 0;
        // 构建所有页面DOM
        updatePageSliderForTxt();
        await goToPage(0);
    }

    function updatePageSliderForTxt() {
        pageSlider.innerHTML = '';
        currentTxtPages.forEach((pageText, idx) => {
            const pageDiv = document.createElement('div');
            pageDiv.className = 'reader-inner txt-page';
            pageDiv.innerHTML = `<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}">${escapeHtml(pageText)}</div>`;
            pageDiv.style.flex = '0 0 100%';
            pageDiv.style.width = '100%';
            pageDiv.style.overflowY = 'auto';
            pageDiv.dataset.pageIndex = idx;
            pageSlider.appendChild(pageDiv);
        });
        // 更新阅读区引用
        readerArea = document.querySelector('.txt-page.active') || pageSlider.firstElementChild;
    }

    // ---------- EPUB 翻页 （直接使用rendition） ----------
    async function setupEpubFlip() {
        // EPUB.js 自带翻页动画，只需确保iframe占满整个pageSlider
        pageSlider.innerHTML = '';
        const pageDiv = document.createElement('div');
        pageDiv.className = 'reader-inner';
        pageDiv.style.flex = '0 0 100%';
        pageDiv.style.width = '100%';
        pageDiv.id = 'readerArea';
        pageSlider.appendChild(pageDiv);
        // 重新获取 readerArea 引用
        readerArea = pageDiv;
    }

    // ---------- PDF 翻页 ----------
    async function renderPdfForFlip() {
        if(!currentPdfDoc) return;
        const pages = [];
        for(let i=1; i<=currentPdfTotalPages; i++) {
            const page = await currentPdfDoc.getPage(i);
            const vp = page.getViewport({scale: 1.5});
            const canvas = document.createElement('canvas');
            canvas.height = vp.height;
            canvas.width = vp.width;
            canvas.className = 'pdf-page-canvas';
            await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
            const pageDiv = document.createElement('div');
            pageDiv.className = 'reader-inner';
            pageDiv.style.flex = '0 0 100%';
            pageDiv.style.width = '100%';
            pageDiv.style.overflowY = 'auto';
            pageDiv.appendChild(canvas);
            pageDiv.dataset.pageIndex = i-1;
            pages.push(pageDiv);
        }
        pageSlider.innerHTML = '';
        pages.forEach(p => pageSlider.appendChild(p));
        readerArea = pageSlider.firstElementChild;
    }

    // ---------- 核心翻页事件 ----------
    function tapLeftHandler(e) {
        e.stopPropagation();
        if(!currentBookType || isAnimating) return;
        const now = Date.now();
        if(now - lastTapTime < 500) return; // 防连点
        lastTapTime = now;

        if(currentBookType === 'epub') {
            currentRendition?.prev();
        } else if(currentBookType === 'pdf') {
            if(currentPdfPageNum > 1) {
                goToPage(currentPdfPageNum - 2); // 页码索引减1
            }
        } else if(currentBookType === 'txt') {
            if(currentTxtPageIndex > 0) {
                goToPage(currentTxtPageIndex - 1);
            }
        }
    }

    function tapRightHandler(e) {
        e.stopPropagation();
        if(!currentBookType || isAnimating) return;
        const now = Date.now();
        if(now - lastTapTime < 500) return;
        lastTapTime = now;

        if(currentBookType === 'epub') {
            currentRendition?.next();
        } else if(currentBookType === 'pdf') {
            if(currentPdfPageNum < currentPdfTotalPages) {
                goToPage(currentPdfPageNum); // 页码索引加1
            }
        } else if(currentBookType === 'txt') {
            if(currentTxtPageIndex < currentTxtPages.length - 1) {
                goToPage(currentTxtPageIndex + 1);
            }
        }
    }

    // ---------- UI控制 ----------
    function openToolbar() { toolbarOverlay.style.display='block'; }
    function closeToolbar() { toolbarOverlay.style.display='none'; }
    function toggleToolbar() { toolbarOverlay.style.display==='block'?closeToolbar():openToolbar(); }
    function openSidebar() { sidebar.classList.add('open'); sidebarMask.style.display='block'; }
    function closeSidebar() { sidebar.classList.remove('open'); sidebarMask.style.display='none'; }

    // 点击空白关闭
    readerContainer.addEventListener('click', (e) => {
        if(toolbarOverlay.style.display==='block' && !e.target.closest('.toolbar-overlay'))
            closeToolbar();
    });
    sidebarMask.addEventListener('click', closeSidebar);
    document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

    // 中间点击呼出工具栏
    document.getElementById('tapCenter').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbar();
    });

    // 翻页事件绑定
    document.getElementById('tapLeft').addEventListener('click', tapLeftHandler);
    document.getElementById('tapRight').addEventListener('click', tapRightHandler);

    // 工具栏按钮（保持不变，但上传后需初始化对应翻页）
    document.getElementById('fileUploadBtn').addEventListener('click', ()=>fileInput.click());
    fileInput.addEventListener('change', async e => {
        if(e.target.files.length) {
            await processFile(e.target.files[0]);
            fileInput.value = '';
        }
    });
    document.getElementById('urlLoadBtn').addEventListener('click', ()=>{
        const url=prompt('输入图书URL:');
        if(url) loadFromUrl(url).catch(err=>alert('加载失败: '+err.message));
    });
    document.getElementById('fontMinusBtn').addEventListener('click', ()=>{
        adjustFontSize(-10);
        if(currentBookType === 'txt') renderTxtPages(); // 重新分页
    });
    document.getElementById('fontPlusBtn').addEventListener('click', ()=>{
        adjustFontSize(10);
        if(currentBookType === 'txt') renderTxtPages();
    });
    themeToggleBtn.addEventListener('click', ()=>setTheme(currentTheme==='light'?'dark':'light'));
    document.getElementById('smartChapterBtn').addEventListener('click', ()=>{
        if(currentBookType!=='txt') return;
        smartChapterMode=!smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        loadTxtWithSmartChapter(); // 重新加载章节模式
    });
    document.getElementById('tocBtn').addEventListener('click', ()=>{
        openSidebar();
        closeToolbar();
    });

    // ---------- 核心加载流程（适配翻页） ----------
    async function processFile(file) {
        if(!file) return;
        const name=file.name, ext=name.split('.').pop().toLowerCase();
        const buffer=await file.arrayBuffer();
        currentBookUrlOrId=`file_${name}_${Date.now()}`;
        await saveBook(currentBookUrlOrId, new Blob([buffer]), name, ext);
        currentFileName = name;
        clearSearch();
        if(ext==='epub') await loadEpub(buffer, name);
        else if(ext==='pdf') await loadPdf(buffer, name);
        else if(ext==='txt') await loadTxt(buffer, name);
        closeToolbar();
        saveConfig();
    }

    async function loadFromUrl(url) {
        const resp=await fetch(url);
        if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob=await resp.blob();
        const filename=url.split('/').pop()||"book";
        await processFile(new File([blob], filename));
    }

    // EPUB加载
    async function loadEpub(buffer, filename) {
        clearReader();
        currentBookType='epub';
        const blob=new Blob([buffer],{type:'application/epub+zip'});
        currentEpubBook=ePub(URL.createObjectURL(blob));
        await setupEpubFlip(); // 准备单页容器
        currentRendition=currentEpubBook.renderTo("readerArea",{width:"100%",height:"100%",spread:"none",flow:"paginated"});
        await currentRendition.display();
        currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
        currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
        setTheme(currentTheme);
        currentRendition.themes.fontSize(currentFontSize+"%");
        const nav=await currentEpubBook.loaded.navigation;
        buildTocFromEpub(nav.toc);
        currentRendition.on('relocated', () => {
            // EPUB翻页不需要手动更新位置
        });
        bookTitleEl.innerText=filename;
        await loadProgress();
    }

    function buildTocFromEpub(toc){
        tocListEl.innerHTML='';
        const renderItems=(items,parent)=>{
            items.forEach(item=>{
                const li=document.createElement('li'); li.className='toc-item'; li.innerText=item.label||'章节';
                if(item.href) li.addEventListener('click',()=>{ currentRendition.display(item.href); closeSidebar(); });
                parent.appendChild(li);
                if(item.subitems) renderItems(item.subitems,parent);
            });
        };
        renderItems(toc,tocListEl);
    }

    // PDF加载
    async function loadPdf(buffer, filename) {
        clearReader();
        currentBookType='pdf';
        currentPdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(buffer)}).promise;
        currentPdfTotalPages=currentPdfDoc.numPages;
        currentPdfPageNum=1;
        await renderPdfForFlip();
        buildPdfToc();
        bookTitleEl.innerText=filename;
        await loadProgress();
    }

    function buildPdfToc(){
        tocListEl.innerHTML='';
        for(let i=1;i<=currentPdfTotalPages;i++){
            const li=document.createElement('li'); li.className='toc-item'; li.innerText=`第${i}页`;
            li.addEventListener('click',()=>{ goToPage(i-1); closeSidebar(); });
            tocListEl.appendChild(li);
        }
    }

    // TXT加载
    async function loadTxt(buffer, filename) {
        clearReader();
        currentBookType='txt';
        const enc=await detectEncoding(buffer);
        currentTxtRaw=new TextDecoder(enc).decode(buffer);
        // 智能章节分割
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        // 默认智能模式开启
        smartChapterMode = true;
        await loadTxtWithSmartChapter();
        bookTitleEl.innerText=filename;
    }

    async function loadTxtWithSmartChapter() {
        if(smartChapterMode && currentTxtChunks.length) {
            // 将当前章节内容作为全文分页
            currentTxtRaw = currentTxtChunks[currentChapterIndex]?.content || '';
            await renderTxtPages();
            buildTocFromChunks();
            bookTitleEl.innerText = currentTxtChunks[currentChapterIndex]?.title || currentFileName;
        } else {
            currentTxtRaw = currentTxtRaw; // 全文模式
            await renderTxtPages();
            tocListEl.innerHTML = '<li class="toc-item">纯文本全文</li>';
            bookTitleEl.innerText = currentFileName;
        }
    }

    function buildTocFromChunks() {
        tocListEl.innerHTML='';
        currentTxtChunks.forEach((ch, i) => {
            const li = document.createElement('li'); li.className='toc-item';
            if(i === currentChapterIndex) li.classList.add('active');
            li.innerText = ch.title.length>20? ch.title.slice(0,18)+'…' : ch.title;
            li.addEventListener('click', () => {
                currentChapterIndex = i;
                currentTxtRaw = ch.content;
                renderTxtPages();
                closeSidebar();
                saveConfig();
            });
            tocListEl.appendChild(li);
        });
    }

    // ---------- 其他函数 ----------
    function clearReader() {
        if(currentRendition) try{currentRendition.destroy()}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy()}catch(e){}
        currentPdfDoc=null; currentTxtRaw=null; currentTxtPages=[];
        pageSlider.innerHTML = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'reader-inner';
        emptyDiv.innerHTML = '<div class="empty-state"><i class="fas fa-cloud-upload-alt" style="font-size:48px;opacity:0.4"></i><p>点击屏幕中央<br>上传图书开始阅读</p></div>';
        pageSlider.appendChild(emptyDiv);
        readerArea = emptyDiv;
        currentBookType=null;
        tocListEl.innerHTML='<li class="empty-toc">暂无目录</li>';
    }

    function setTheme(theme){
        currentTheme=theme;
        document.body.classList.toggle('dark', theme==='dark');
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.select(theme);
        saveConfig();
    }

    function adjustFontSize(delta){
        currentFontSize=Math.min(180,Math.max(70, currentFontSize+delta));
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize+"%");
        saveConfig();
    }

    // 编码检测（保持不变）
    async function detectEncoding(buffer) { ... } // 与之前完全相同，省略节省篇幅

    function splitIntelligentChapters(text) { ... } // 与之前完全相同

    function escapeHtml(s){ return s.replace(/[&<>]/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':'&gt;'); }

    // 搜索功能（简化，仅高亮当前可见页）
    function clearSearch() { ... } // 保留原有搜索逻辑，仅需修改高亮获取范围

    // ---------- 进度保存与恢复 ----------
    async function saveProgress() {
        if(!currentFileName) return;
        const key = `m_progress_${currentFileName}`;
        let data = { type: currentBookType };
        if(currentBookType === 'epub' && currentRendition) {
            try {
                const loc = currentRendition.currentLocation();
                if(loc?.start?.cfi) data.cfi = loc.start.cfi;
            } catch(e) {}
        } else if(currentBookType === 'pdf') data.page = currentPdfPageNum;
        else if(currentBookType === 'txt') data.pageIndex = currentTxtPageIndex;
        localStorage.setItem(key, JSON.stringify(data));
    }

    async function loadProgress() {
        if(!currentFileName) return;
        const raw = localStorage.getItem(`m_progress_${currentFileName}`);
        if(!raw) return;
        try {
            const data = JSON.parse(raw);
            if(data.type === 'epub' && currentBookType === 'epub' && data.cfi) {
                currentRendition.display(data.cfi);
            } else if(data.type === 'pdf' && currentBookType === 'pdf') {
                goToPage(data.page - 1);
            } else if(data.type === 'txt' && currentBookType === 'txt') {
                currentTxtPageIndex = data.pageIndex || 0;
                goToPage(currentTxtPageIndex);
            }
        } catch(e) {}
    }

    // ---------- 初始化 ----------
    const cfg = loadConfig();
    setTheme(currentTheme);
    adjustFontSize(0);
    (async ()=>{
        if(cfg.lastBookId){
            const record = await loadBook(cfg.lastBookId);
            if(record?.blob){
                const file = new File([record.blob], record.fileName, {type:`application/${record.fileType}`});
                await processFile(file);
            }
        }
    })();

    // 窗口大小变化重新分页（仅TXT）
    window.addEventListener('resize', () => {
        if(currentBookType === 'txt') renderTxtPages();
    });
})();
