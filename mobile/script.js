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

    // DOM元素（⚠️ readerArea 需用 let，因为后续会重新赋值）
    const readerContainer = document.getElementById('readerContainer');
    let readerArea = document.getElementById('readerArea');
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

    // 搜索相关（⚠️ 补充 currentSearchMatches 声明）
    let currentSearchTerm = "";
    let currentSearchMatches = [];
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
            currentTxtPageIndex = pageIndex;
        }
        // EPUB 由rendition管理，不在此处处理
        saveConfig();
    }

    // ---------- 文本分页（TXT专用） ----------
    function paginateTxtText(text, containerHeight) {
        const measureDiv = document.createElement('div');
        measureDiv.style.cssText = `position:absolute;visibility:hidden;width:${readerContainer.clientWidth - 24}px;font:${(currentFontSize/100)*1.1}rem Georgia,Times New Roman,serif;line-height:1.6;white-space:pre-wrap;word-break:break-word;padding:0;`;
        document.body.appendChild(measureDiv);
        
        const pages = [];
        let remaining = text;
        while(remaining.length > 0) {
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
            if(bestFit === 0) bestFit = 1;
            pages.push(remaining.slice(0, bestFit));
            remaining = remaining.slice(bestFit);
        }
        document.body.removeChild(measureDiv);
        return pages.length ? pages : [''];
    }

    async function renderTxtPages() {
        if(!currentTxtRaw) return;
        const containerHeight = readerContainer.clientHeight - 24;
        currentTxtPages = paginateTxtText(currentTxtRaw, containerHeight);
        currentTxtPageIndex = 0;
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
        // 重新指定 readerArea 为当前活动页（默认第一页），const 改为 let 后这里可行
        readerArea = pageSlider.firstElementChild;
    }

    // ---------- EPUB 翻页 ----------
    async function setupEpubFlip() {
        pageSlider.innerHTML = '';
        const pageDiv = document.createElement('div');
        pageDiv.className = 'reader-inner';
        pageDiv.style.flex = '0 0 100%';
        pageDiv.style.width = '100%';
        pageDiv.id = 'readerArea';
        pageSlider.appendChild(pageDiv);
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
        if(now - lastTapTime < 500) return;
        lastTapTime = now;

        if(currentBookType === 'epub') {
            currentRendition?.prev();
        } else if(currentBookType === 'pdf') {
            if(currentPdfPageNum > 1) {
                goToPage(currentPdfPageNum - 2);
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
                goToPage(currentPdfPageNum);
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

    readerContainer.addEventListener('click', (e) => {
        if(toolbarOverlay.style.display==='block' && !e.target.closest('.toolbar-overlay'))
            closeToolbar();
    });
    sidebarMask.addEventListener('click', closeSidebar);
    document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

    document.getElementById('tapCenter').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbar();
    });

    document.getElementById('tapLeft').addEventListener('click', tapLeftHandler);
    document.getElementById('tapRight').addEventListener('click', tapRightHandler);

    // 工具栏按钮
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
        if(currentBookType === 'txt') renderTxtPages();
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
        loadTxtWithSmartChapter();
    });
    document.getElementById('tocBtn').addEventListener('click', ()=>{
        openSidebar();
        closeToolbar();
    });

    // ---------- 核心加载流程 ----------
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
        await setupEpubFlip();
        currentRendition=currentEpubBook.renderTo("readerArea",{width:"100%",height:"100%",spread:"none",flow:"paginated"});
        await currentRendition.display();
        currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
        currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
        setTheme(currentTheme);
        currentRendition.themes.fontSize(currentFontSize+"%");
        const nav=await currentEpubBook.loaded.navigation;
        buildTocFromEpub(nav.toc);
        currentRendition.on('relocated', () => {});
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
        currentTxtChunks = splitIntelligentChapters(currentTxtRaw);
        smartChapterMode = true;
        await loadTxtWithSmartChapter();
        bookTitleEl.innerText=filename;
        // ⚠️ 补充加载进度恢复
        await loadProgress();
    }

    async function loadTxtWithSmartChapter() {
        if(smartChapterMode && currentTxtChunks.length) {
            currentTxtRaw = currentTxtChunks[currentChapterIndex]?.content || '';
            await renderTxtPages();
            buildTocFromChunks();
            bookTitleEl.innerText = currentTxtChunks[currentChapterIndex]?.title || currentFileName;
        } else {
            // 全文模式不需要重新赋值 currentTxtRaw = currentTxtRaw
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
            } catch (e) {}
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
        for (let line of lines) {
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

    function escapeHtml(s){ return s.replace(/[&<>]/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':'&gt;'); }

    // ---------- 搜索功能 ----------
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
            const start = Math.max(0, idx - 20);
            const end = Math.min(localText.length, idx + query.length + 20);
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
    
        const globalRes = [];
        if (currentBookType === 'txt' && smartChapterMode && currentTxtChunks.length) {
            currentTxtChunks.forEach((ch, i) => {
                const count = (ch.content.toLowerCase().split(lowerQuery).length - 1);
                if (count > 0) globalRes.push({ chapterIndex: i, title: ch.title, count });
            });
        }
        globalMatchList.innerHTML = globalRes.length
            ? globalRes.map(r => `<li data-chapter="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count})</li>`).join('')
            : '<li>全文无匹配</li>';
    
        searchDropdown.style.display = "block";
        highlightLocalMatches();
    }
    
    function getCurrentVisibleText() {
        if (currentBookType === 'txt') {
            if (smartChapterMode && currentTxtPages.length) {
                return currentTxtPages[currentTxtPageIndex] || '';
            }
            return currentTxtRaw || '';
        }
        return '';
    }
    
    function highlightLocalMatches() {
        removeHighlights();
        if (!currentSearchTerm) return;
        const container = document.querySelector('.txt-viewer') || document.querySelector('.reader-inner.active .txt-viewer');
        if (container) {
            const regex = new RegExp(`(${escapeRegex(currentSearchTerm)})`, 'gi');
            container.innerHTML = container.innerHTML.replace(regex, '<mark>$1</mark>');
        }
    }
    
    function removeHighlights() {
        const container = document.querySelector('.txt-viewer') || document.querySelector('.reader-inner.active .txt-viewer');
        if (container) container.innerHTML = container.innerHTML.replace(/<\/?mark[^>]*>/gi, '');
    }
    
    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
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
        const container = document.querySelector('.txt-viewer') || document.querySelector('.reader-inner.active .txt-viewer');
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
            currentChapterIndex = chapterIdx;
            currentTxtRaw = currentTxtChunks[chapterIdx].content;
            renderTxtPages();
            closeToolbar();
            setTimeout(() => performSearch(currentSearchTerm), 300);
        }
    });

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

    window.addEventListener('resize', () => {
        if(currentBookType === 'txt') renderTxtPages();
    });
})();
