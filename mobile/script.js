/* =========================
   ZZX Reader · Mobile Stable
   ========================= */

(function () {
    'use strict';

    /* ===== DOM ===== */
    const readerContainer = document.getElementById('readerContainer');
    const readerArea = document.getElementById('readerArea');
    const fileInput = document.getElementById('fileInput');
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const searchDropdown = document.getElementById('searchDropdown');
    const localMatchList = document.getElementById('localMatchList');
    const globalMatchList = document.getElementById('globalMatchList');
    const toolbar = document.getElementById('toolbarOverlay');
    const sidebar = document.getElementById('sidebar');
    const sidebarMask = document.getElementById('sidebarMask');
    const tocList = document.getElementById('tocList');
    const bookTitle = document.getElementById('bookTitle');

    /* ===== State ===== */
    let bookType = null;
    let bookName = '';
    let epubBook = null;
    let epubRendition = null;
    let pdfDoc = null;
    let pdfPage = 1;
    let txtRaw = '';
    let txtChapters = [];
    let txtChapterIndex = 0;
    let smartMode = false;
    let fontSize = 100;
    let theme = 'light';

    /* ===== Utils ===== */
    const debounce = (fn, ms) => {
        let t;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    };

    const escapeHTML = str =>
        str.replace(/[&<>]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])
        );

    /* ===== UI ===== */
    const showToolbar = () => toolbar.style.display = 'block';
    const hideToolbar = () => toolbar.style.display = 'none';

    document.addEventListener('click', e => {
        if (e.target.closest('.reader-container')) {
            toolbar.style.display === 'none' ? showToolbar() : hideToolbar();
        }
    });

    /* ===== Theme / Font ===== */
    const applyTheme = () => {
        document.body.classList.toggle('dark', theme === 'dark');
        if (epubRendition) epubRendition.themes.select(theme);
        localStorage.setItem('zzx_theme', theme);
    };

    const changeFontSize = delta => {
        fontSize = Math.min(180, Math.max(70, fontSize + delta));
        if (epubRendition) epubRendition.themes.fontSize(fontSize + '%');
        document.querySelectorAll('.txt-viewer').forEach(el =>
            el.style.fontSize = (fontSize / 100 * 1.1) + 'rem'
        );
        localStorage.setItem('zzx_font', fontSize);
    };

    /* ===== Clear Reader ===== */
    const clearReader = () => {
        readerArea.innerHTML = '<div class="empty-state">点击上传图书</div>';
        txtChapters = [];
        txtRaw = '';
        epubBook = null;
        pdfDoc = null;
    };

    /* ===== TXT（稳定版）===== */
    const renderTxtChapter = index => {
        if (!txtChapters.length) return;
        txtChapterIndex = Math.max(0, Math.min(txtChapters.length - 1, index));
        const ch = txtChapters[txtChapterIndex];

        readerArea.innerHTML = `
        <div class="txt-viewer" style="font-size:${fontSize / 100 * 1.1}rem">
            <h3>${escapeHTML(ch.title)}</h3>
            <div>${escapeHTML(ch.content)}</div>
        </div>`;

        bookTitle.innerText = ch.title;
        highlightSearch();
    };

    /* ===== Search（不炸 DOM）===== */
    let currentSearch = '';

    const highlightSearch = () => {
        removeHighlight();
        if (!currentSearch) return;

        const walker = document.createTreeWalker(
            readerArea,
            NodeFilter.SHOW_TEXT
        );

        let node;
        while ((node = walker.nextNode())) {
            const idx = node.textContent.toLowerCase().indexOf(currentSearch);
            if (idx >= 0) {
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + currentSearch.length);
                const mark = document.createElement('mark');
                range.surroundContents(mark);
            }
        }
    };

    const removeHighlight = () => {
        readerArea.querySelectorAll('mark').forEach(m => {
            m.replaceWith(document.createTextNode(m.textContent));
        });
    };

    searchInput.addEventListener('input', debounce(() => {
        currentSearch = searchInput.value.trim().toLowerCase();
        clearSearchBtn.style.display = currentSearch ? 'block' : 'none';
        highlightSearch();
    }, 300));

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        currentSearch = '';
        removeHighlight();
        clearSearchBtn.style.display = 'none';
    });

    /* ===== File Handler ===== */
    fileInput.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        clearReader();
        bookName = file.name;

        const buffer = await file.arrayBuffer();
        const ext = file.name.split('.').pop().toLowerCase();

        if (ext === 'epub') {
            epubBook = ePub(new Blob([buffer]));
            epubRendition = epubBook.renderTo(readerArea, {
                width: '100%',
                height: '100%'
            });
            await epubRendition.display();
            epubRendition.themes.select(theme);
            epubRendition.themes.fontSize(fontSize + '%');
        }

        if (ext === 'txt') {
            const text = new TextDecoder('utf-8').decode(buffer);
            txtRaw = text;
            txtChapters = [{ title: '全文', content: text }];
            renderTxtChapter(0);
        }
    });

    /* ===== Init ===== */
    theme = localStorage.getItem('zzx_theme') || 'light';
    fontSize = Number(localStorage.getItem('zzx_font')) || 100;
    applyTheme();

})();
