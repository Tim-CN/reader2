(function(){
    // ---------- 基础变量 ----------
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

    // 搜索相关
    let currentSearchTerm = "";
    let currentSearchMatches = [];
    let searchDebounceTimer;

    // IndexedDB 简化
    let db = null;
    const DB_NAME = "ZZXMobileDB";
    const STORE_NAME = "books";

    // 辅助
    function showLoading(show, text="加载中...") {
        // 可扩展
    }

    // IndexedDB
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
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const req = store.put({ id, blob, fileName: name, fileType: type, timestamp: Date.now() });
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
        });
    }

    async function loadBook(id) {
        if(!db) await initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function saveConfig() {
        localStorage.setItem("zzx_mob_config", JSON.stringify({
            fontSize: currentFontSize,
            theme: currentTheme,
            smartMode: smartChapterMode,
            lastBookId: currentBookUrlOrId,
            lastType: currentBookType,
            lastFileName: currentFileName
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
        else if(currentBookType === 'txt') {
            if(smartChapterMode) data.chapter = currentChapterIndex;
            else data.scroll = readerArea.scrollTop / (readerArea.scrollHeight - readerContainer.clientHeight);
        }
        localStorage.setItem(key, JSON.stringify(data));
        saveConfig();
    }

    async function loadProgress() {
        if(!currentFileName) return;
        const raw = localStorage.getItem(`m_progress_${currentFileName}`);
        if(!raw) return;
        try {
            const data = JSON.parse(raw);
            if(data.type === 'epub' && currentBookType === 'epub' && data.cfi) await currentRendition.display(data.cfi);
            else if(data.type === 'pdf' && currentBookType === 'pdf') await renderPdfPage(data.page, true);
            else if(data.type === 'txt' && currentBookType === 'txt') {
                if(data.chapter !== undefined && smartChapterMode) await renderTxtChapter(data.chapter);
                else if(data.scroll) {
                    await renderFullTxtLazy();
                    setTimeout(() => readerArea.scrollTop = data.scroll * (readerArea.scrollHeight - readerContainer.clientHeight), 100);
                }
            }
        } catch(e) {}
    }

    // 编码检测
    async function detectEncoding(buffer) {
        const encs = ['utf-8','gbk','gb2312','big5','shift-jis','euc-kr'];
        const sample = buffer.slice(0,4096);
        function score(t) {
            let v=0;
            for(let i=0;i<t.length&&i<1000;i++){
                const c=t.charCodeAt(i);
                if((c>=0x4E00&&c<=0x9FFF)||(c>=0x3040&&c<=0x30FF)||(c>=0xAC00&&c<=0xD7AF)||(c>=0x20&&c<=0x7E)||c===0x0A||c===0x0D||c===0x09) v++;
            }
            return v/(t.length||1);
        }
        let best='utf-8',bestScore=0;
        for(const e of encs) {
            try{ const t=new TextDecoder(e,{fatal:false}).decode(sample); const s=score(t); if(s>bestScore){bestScore=s;best=e;} if(bestScore>0.95)break;}catch(e){}
        }
        return best;
    }

    // 智能章节
    function splitIntelligentChapters(text) {
        const unitCounter={};
        const pat=/^第([\d零一二三四五六七八九十百千万]+)([章节卷回部篇集辑课程])/gm;
        let m;
        while((m=pat.exec(text))!==null) unitCounter[m[2]]=(unitCounter[m[2]]||0)+1;
        let bestUnit=null,max=0;
        for(const u in unitCounter) if(unitCounter[u]>max){max=unitCounter[u];bestUnit=u;}
        const splitPat=bestUnit?new RegExp(`^(第[\\d零一二三四五六七八九十百千万]+${bestUnit})`,'gm'):/^(第[\d零一二三四五六七八九十百千万]+[章节卷回部篇集辑课程]?)/gm;
        const lines=text.split(/\r?\n/);
        const chapters=[];
        let title="序言",content=[];
        for(const line of lines){
            const t=line.trim();
            splitPat.lastIndex=0;
            if(splitPat.test(t)&&t.length<50){
                if(content.length) chapters.push({title, content:content.join('\n')});
                title=t; content=[];
            }else content.push(line);
        }
        if(content.length) chapters.push({title, content:content.join('\n')});
        return chapters.length?chapters:[{title:"全文",content:text}];
    }

    async function renderTxtChapter(index) {
        if(!currentTxtChunks.length) return;
        currentChapterIndex=Math.min(Math.max(0,index),currentTxtChunks.length-1);
        const ch=currentTxtChunks[currentChapterIndex];
        readerArea.innerHTML=`<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"><h3>${escapeHtml(ch.title)}</h3><div style="white-space:pre-wrap;">${escapeHtml(ch.content)}</div></div>`;
        updateTocForSmartChapters();
        bookTitleEl.innerText=ch.title;
        readerArea.scrollTop=0;
        if(currentSearchTerm) performSearch(currentSearchTerm);
        saveProgress();
    }

    function updateTocForSmartChapters() {
        if(!smartChapterMode||!currentTxtChunks.length) return;
        tocListEl.innerHTML='';
        currentTxtChunks.forEach((ch,i)=>{
            const li=document.createElement('li'); li.className='toc-item';
            if(i===currentChapterIndex) li.classList.add('active');
            li.innerText=ch.title.length>20?ch.title.slice(0,18)+'…':ch.title;
            li.addEventListener('click',()=>{ renderTxtChapter(i); closeSidebar(); });
            tocListEl.appendChild(li);
        });
    }

    async function renderFullTxtLazy() {
        if(!currentTxtRaw) return;
        readerArea.innerHTML=`<div class="txt-viewer" style="font-size:${(currentFontSize/100)*1.1}rem; color:${currentTheme==='dark'?'#e2e8f0':'#1e293b'}"></div>`;
        const container=readerArea.querySelector('.txt-viewer');
        let idx=0;
        function next(){
            const chunk=currentTxtRaw.slice(idx,idx+50000);
            if(chunk){ container.appendChild(document.createTextNode(chunk)); idx+=50000; requestAnimationFrame(()=>idx<currentTxtRaw.length?next():(saveProgress(),currentSearchTerm&&performSearch(currentSearchTerm))); }
            else saveProgress();
        }
        next();
        bookTitleEl.innerText=currentFileName;
    }

    function escapeHtml(s){ return s.replace(/[&<>]/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':'&gt;'); }

    async function loadEpub(buffer, filename) {
        clearReader(); currentBookType='epub'; currentFileName=filename;
        const blob=new Blob([buffer],{type:'application/epub+zip'});
        currentEpubBook=ePub(URL.createObjectURL(blob));
        currentRendition=currentEpubBook.renderTo("readerArea",{width:"100%",height:"100%",spread:"none",flow:"paginated"});
        await currentRendition.display();
        currentRendition.themes.register('light',{body:{background:'#fefefe',color:'#1e293b'}});
        currentRendition.themes.register('dark',{body:{background:'#11131f',color:'#e2e8f0'}});
        setTheme(currentTheme);
        currentRendition.themes.fontSize(currentFontSize+"%");
        const nav=await currentEpubBook.loaded.navigation;
        buildEpubToc(nav.toc);
        currentRendition.on('relocated',saveProgress);
        await loadProgress();
        bookTitleEl.innerText=filename;
        saveConfig();
    }

    function buildEpubToc(toc){
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

    async function loadPdf(buffer, filename) {
        clearReader(); currentBookType='pdf'; currentFileName=filename;
        currentPdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(buffer)}).promise;
        currentPdfTotalPages=currentPdfDoc.numPages;
        await renderPdfPage(1);
        await loadProgress();
        bookTitleEl.innerText=filename;
        saveConfig();
    }

    async function renderPdfPage(pageNum, isJump=false) {
        if(!currentPdfDoc) return;
        currentPdfPageNum=Math.min(Math.max(1,pageNum),currentPdfTotalPages);
        readerArea.innerHTML='<div class="pdf-viewer" id="pdfViewer"></div>';
        const container=document.getElementById('pdfViewer');
        for(let i=1;i<=currentPdfTotalPages;i++){
            const page=await currentPdfDoc.getPage(i);
            const vp=page.getViewport({scale:1.5});
            const canvas=document.createElement('canvas'); canvas.height=vp.height; canvas.width=vp.width;
            canvas.className='pdf-page-canvas'; canvas.dataset.pageNum=i;
            await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
            container.appendChild(canvas);
        }
        if(isJump) document.querySelector(`.pdf-page-canvas[data-page-num="${currentPdfPageNum}"]`)?.scrollIntoView({behavior:'smooth'});
        buildPdfToc();
        saveProgress();
    }

    function buildPdfToc(){
        tocListEl.innerHTML='';
        for(let i=1;i<=currentPdfTotalPages;i++){
            const li=document.createElement('li'); li.className='toc-item'; li.innerText=`第${i}页`;
            li.addEventListener('click',()=>{ renderPdfPage(i,true); closeSidebar(); });
            tocListEl.appendChild(li);
        }
    }

    function clearReader(){
        if(currentRendition) try{currentRendition.destroy()}catch(e){}
        if(currentEpubBook) try{currentEpubBook.destroy()}catch(e){}
        currentPdfDoc=null; currentTxtRaw=null; currentTxtChunks=[];
        readerArea.innerHTML=''; currentBookType=null;
        tocListEl.innerHTML='<li class="empty-toc">暂无目录</li>';
        clearSearch();
    }

    function setTheme(theme){
        currentTheme=theme;
        document.body.classList.toggle('dark', theme==='dark');
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.select(theme);
        if(currentBookType==='txt'){
            const tv=document.querySelector('.txt-viewer');
            if(tv) tv.style.color=theme==='dark'?'#e2e8f0':'#1e293b';
        }
        saveConfig();
    }

    function adjustFontSize(delta){
        currentFontSize=Math.min(180,Math.max(70, currentFontSize+delta));
        if(currentBookType==='epub' && currentRendition) currentRendition.themes.fontSize(currentFontSize+"%");
        if(currentBookType==='txt'){
            const tv=document.querySelector('.txt-viewer');
            if(tv) tv.style.fontSize=(currentFontSize/100)*1.1+"rem";
        }
        saveConfig();
    }

    async function processFile(file){
        if(!file) return;
        const name=file.name, ext=name.split('.').pop().toLowerCase();
        const buffer=await file.arrayBuffer();
        currentBookUrlOrId=`file_${name}_${Date.now()}`;
        await saveBook(currentBookUrlOrId, new Blob([buffer]), name, ext);
        clearSearch();
        if(ext==='epub') await loadEpub(buffer, name);
        else if(ext==='pdf') await loadPdf(buffer, name);
        else if(ext==='txt') await loadTxtSmartOrPlain(buffer, name);
        else alert('不支持的格式');
        closeToolbar();
        saveConfig();
    }

    async function loadTxtSmartOrPlain(buffer, filename){
        clearReader(); currentBookType='txt'; currentFileName=filename;
        const enc=await detectEncoding(buffer);
        currentTxtRaw=new TextDecoder(enc).decode(buffer);
        currentTxtChunks=splitIntelligentChapters(currentTxtRaw);
        const saved=localStorage.getItem(`txt_smart_mode_${filename}`);
        if(saved!==null) smartChapterMode=saved==='true';
        if(smartChapterMode&&currentTxtChunks.length) await renderTxtChapter(0);
        else { await renderFullTxtLazy(); tocListEl.innerHTML='<li class="toc-item">纯文本模式</li>'; }
        await loadProgress();
        saveConfig();
    }

    async function loadFromUrl(url){
        const resp=await fetch(url);
        if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob=await resp.blob();
        const filename=url.split('/').pop()||"book";
        await processFile(new File([blob], filename));
    }

    // ---------- UI 控制 ----------
    function openToolbar() { toolbarOverlay.style.display='block'; }
    function closeToolbar() { toolbarOverlay.style.display='none'; }
    function toggleToolbar() { toolbarOverlay.style.display==='block'?closeToolbar():openToolbar(); }
    function openSidebar() { sidebar.classList.add('open'); sidebarMask.style.display='block'; }
    function closeSidebar() { sidebar.classList.remove('open'); sidebarMask.style.display='none'; }

    // 点击空白关闭工具栏/目录
    readerContainer.addEventListener('click', (e) => {
        if(toolbarOverlay.style.display==='block' && !e.target.closest('.toolbar-overlay'))
            closeToolbar();
    });
    sidebarMask.addEventListener('click', closeSidebar);
    document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);

    // 中间点击
    document.getElementById('tapCenter').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbar();
    });

    // 左右翻页
    document.getElementById('tapLeft').addEventListener('click', (e) => {
        e.stopPropagation();
        if(!currentBookType) return;
        if(currentBookType==='epub') currentRendition?.prev();
        else if(currentBookType==='pdf') { if(currentPdfPageNum>1) renderPdfPage(currentPdfPageNum-1, true); }
        else if(currentBookType==='txt'){
            const h=readerContainer.clientHeight;
            if(readerArea.scrollTop<=10 && smartChapterMode){
                if(currentChapterIndex>0) renderTxtChapter(currentChapterIndex-1);
            } else readerArea.scrollBy({top:-h, behavior:'smooth'});
        }
    });
    document.getElementById('tapRight').addEventListener('click', (e) => {
        e.stopPropagation();
        if(!currentBookType) return;
        if(currentBookType==='epub') currentRendition?.next();
        else if(currentBookType==='pdf') { if(currentPdfPageNum<currentPdfTotalPages) renderPdfPage(currentPdfPageNum+1, true); }
        else if(currentBookType==='txt'){
            const h=readerContainer.clientHeight;
            const max=readerArea.scrollHeight-h;
            if(readerArea.scrollTop>=max-10 && smartChapterMode){
                if(currentChapterIndex<currentTxtChunks.length-1) renderTxtChapter(currentChapterIndex+1);
            } else readerArea.scrollBy({top:h, behavior:'smooth'});
        }
    });

    // 工具栏按钮
    document.getElementById('fileUploadBtn').addEventListener('click', ()=>fileInput.click());
    fileInput.addEventListener('change', e=>{ if(e.target.files.length) processFile(e.target.files[0]); fileInput.value=''; });
    document.getElementById('urlLoadBtn').addEventListener('click', ()=>{
        const url=prompt('输入图书URL:');
        if(url) loadFromUrl(url).catch(err=>alert('加载失败: '+err.message));
    });
    document.getElementById('fontMinusBtn').addEventListener('click', ()=>adjustFontSize(-10));
    document.getElementById('fontPlusBtn').addEventListener('click', ()=>adjustFontSize(10));
    themeToggleBtn.addEventListener('click', ()=>setTheme(currentTheme==='light'?'dark':'light'));
    document.getElementById('smartChapterBtn').addEventListener('click', ()=>{
        if(currentBookType!=='txt') return;
        smartChapterMode=!smartChapterMode;
        localStorage.setItem(`txt_smart_mode_${currentFileName}`, smartChapterMode);
        if(smartChapterMode) renderTxtChapter(currentChapterIndex);
        else renderFullTxtLazy();
        saveConfig();
    });
    document.getElementById('tocBtn').addEventListener('click', ()=>{
        openSidebar();
        closeToolbar();
    });

    // 搜索
    function clearSearch() {
        currentSearchTerm="";
        searchInput.value="";
        searchDropdown.style.display="none";
        removeHighlights();
    }

    function performSearch(query) {
        currentSearchTerm=query;
        if(!query.trim()){ searchDropdown.style.display='none'; removeHighlights(); return; }
        const lower=query.toLowerCase();
        // 本页
        const localText=getVisibleText();
        const localMatches=[];
        let idx=localText.toLowerCase().indexOf(lower);
        while(idx!==-1){
            const start=Math.max(0,idx-20), end=Math.min(localText.length,idx+query.length+20);
            localMatches.push({start:idx,end:idx+query.length,text:localText.slice(start,end).replace(/\n/g,' ')});
            idx=localText.toLowerCase().indexOf(lower,idx+1);
        }
        currentSearchMatches=localMatches;
        localMatchList.innerHTML=localMatches.length?localMatches.map(m=>`<li>...${escapeHtml(m.text)}...</li>`).join(''):'<li>无匹配</li>';

        // 全文
        const globalRes=[];
        if(currentBookType==='txt' && smartChapterMode && currentTxtChunks.length){
            currentTxtChunks.forEach((ch,i)=>{
                const count=ch.content.toLowerCase().split(lower).length-1;
                if(count>0) globalRes.push({chapterIndex:i, title:ch.title, count});
            });
        }
        globalMatchList.innerHTML=globalRes.length?globalRes.map(r=>`<li data-chapter="${r.chapterIndex}">${escapeHtml(r.title)} (${r.count})</li>`).join(''):'<li>全文无匹配</li>';
        searchDropdown.style.display='block';
        highlightLocalMatches();
    }

    function getVisibleText(){
        if(currentBookType==='txt') return smartChapterMode?currentTxtChunks[currentChapterIndex]?.content||'':currentTxtRaw||'';
        return readerArea.innerText||'';
    }

    function highlightLocalMatches(){
        removeHighlights();
        if(!currentSearchTerm) return;
        const container=document.querySelector('.txt-viewer div')||document.querySelector('.txt-viewer');
        if(container) container.innerHTML=container.innerHTML.replace(new RegExp(`(${escapeRegex(currentSearchTerm)})`,'gi'),'<mark>$1</mark>');
    }
    function removeHighlights(){
        const container=document.querySelector('.txt-viewer div')||document.querySelector('.txt-viewer');
        if(container) container.innerHTML=container.innerHTML.replace(/<\/?mark[^>]*>/gi,'');
    }
    function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

    searchInput.addEventListener('input', ()=>{
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer=setTimeout(()=>performSearch(searchInput.value), 300);
    });
    clearSearchBtn.addEventListener('click', clearSearch);
    document.addEventListener('click', (e)=>{ if(!e.target.closest('.search-row')) searchDropdown.style.display='none'; });

    localMatchList.addEventListener('click', e=>{
        const li=e.target.closest('li');
        if(!li||!currentSearchMatches.length) return;
        const index=Array.from(localMatchList.children).indexOf(li);
        const match=currentSearchMatches[index];
        if(!match) return;
        const container=document.querySelector('.txt-viewer div')||document.querySelector('.txt-viewer');
        if(container){
            const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
            let node,off=0;
            while((node=walker.nextNode())){
                const len=node.textContent.length;
                if(off+len>match.start){
                    const r=document.createRange();
                    r.setStart(node,match.start-off);
                    r.setEnd(node,match.end-off);
                    r.startContainer.parentElement.scrollIntoView({behavior:'smooth',block:'center'});
                    break;
                }
                off+=len;
            }
        }
    });
    globalMatchList.addEventListener('click', e=>{
        const li=e.target.closest('li');
        if(!li) return;
        const chapterIdx=parseInt(li.dataset.chapter,10);
        if(!isNaN(chapterIdx)&&currentTxtChunks.length){
            renderTxtChapter(chapterIdx).then(()=>setTimeout(()=>performSearch(currentSearchTerm),300));
        }
    });

    // 初始化
    const cfg=loadConfig();
    setTheme(currentTheme);
    adjustFontSize(0);
    (async ()=>{
        if(cfg.lastBookId){
            const record=await loadBook(cfg.lastBookId);
            if(record?.blob){
                const file=new File([record.blob], record.fileName, {type:`application/${record.fileType}`});
                await processFile(file);
            }
        }
    })();

    // 滚动保存进度
    let saveTimer;
    readerArea.addEventListener('scroll', ()=>{
        clearTimeout(saveTimer);
        saveTimer=setTimeout(saveProgress,600);
    }, {passive:true});
})();
