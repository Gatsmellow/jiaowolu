/*
 * pdf-tools.js — 可复用的 PDF 文字提取 / 页面渲染工具。
 * 只要页面先加载 pdf.js 与本文件，就可以用 window.PdfTools。
 * 没有构建、没有运行时依赖、不会把 PDF 传到服务器。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    maxTextPages: 200,
    maxTextChars: 80000,
    dpi: 170,
    maxEdge: 1800,
    imageType: 'image/jpeg',
    quality: 0.88,
    maxRenderPages: 30
  };

  var config = {
    workerSrc: '',
    cMapUrl: '',
    standardFontDataUrl: ''
  };

  var crcTable = null;

  function configure(options) {
    options = options || {};
    if (options.workerSrc) config.workerSrc = String(options.workerSrc);
    if (options.cMapUrl) config.cMapUrl = String(options.cMapUrl);
    if (options.standardFontDataUrl) config.standardFontDataUrl = String(options.standardFontDataUrl);
  }

  function assetUrl(path) {
    return new URL(path, document.baseURI).href;
  }

  function ensurePdfJs() {
    if (!global.pdfjsLib) {
      throw new Error('PDF.js 未加载，请先在页面中加载 vendor/pdfjs/pdf.min.js');
    }
    if (!config.workerSrc) {
      config.workerSrc = assetUrl('vendor/pdfjs/pdf.worker.min.js');
    }
    if (!config.cMapUrl) {
      config.cMapUrl = assetUrl('vendor/pdfjs/cmaps/');
    }
    if (!config.standardFontDataUrl) {
      config.standardFontDataUrl = assetUrl('vendor/pdfjs/standard_fonts/');
    }
    global.pdfjsLib.GlobalWorkerOptions.workerSrc = config.workerSrc;
  }

  // 打开一个 File/Blob，返回 PDF.js 的 PDFDocumentProxy；用完记得调用 pdf.destroy()。
  async function openPdf(file, options) {
    ensurePdfJs();
    if (!(file instanceof Blob)) {
      throw new TypeError('openPdf 需要一个 File 或 Blob');
    }
    var data = new Uint8Array(await file.arrayBuffer());
    var loadingTask = global.pdfjsLib.getDocument(Object.assign({
      data: data,
      isEvalSupported: false,
      useSystemFonts: true,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: config.standardFontDataUrl
    }, options || {}));
    return loadingTask.promise;
  }

  function textFromContent(content) {
    var text = '';
    (content.items || []).forEach(function (item) {
      if (typeof item.str !== 'string') return;
      text += item.str;
      if (item.hasEOL) text += '\n';
    });
    return text.replace(/[ \t]+\n/g, '\n').trim();
  }

  // 提取文字层；不负责 OCR。pages 里保留逐页文本，方便下载 JSON 或按页处理。
  async function extractText(pdf, options) {
    options = Object.assign({}, DEFAULTS, options || {});
    var limit = Math.min(pdf.numPages, Math.max(1, options.maxTextPages));
    var pages = [];
    var total = 0;
    var truncated = false;
    for (var number = 1; number <= limit; number += 1) {
      var page = await pdf.getPage(number);
      var text = '';
      try {
        var content = await page.getTextContent({ normalizeWhitespace: true });
        text = textFromContent(content);
      } finally {
        try { page.cleanup(); } catch (error) { /* ignore */ }
      }
      pages.push({ page: number, text: text, chars: text.length });
      total += text.length;
      if (total >= options.maxTextChars) {
        truncated = total > options.maxTextChars || number < pdf.numPages;
        break;
      }
    }
    var body = pages.filter(function (item) { return item.text; }).map(function (item) {
      return '--- 第 ' + item.page + ' 页 ---\n' + item.text;
    }).join('\n\n');
    return {
      pageCount: pdf.numPages,
      pages: pages,
      text: body,
      chars: total,
      formattedChars: body.length,
      processedPages: pages.length,
      truncated: truncated,
      empty: !pages.some(function (item) { return item.text; })
    };
  }

  // 把某一页渲染为 data URL；默认 170 DPI、最长边 1800px。
  async function renderPage(pdf, number, options) {
    options = Object.assign({}, DEFAULTS, options || {});
    if (number < 1 || number > pdf.numPages) {
      throw new RangeError('页码超出范围：' + number);
    }
    var page = await pdf.getPage(number);
    try {
      var baseViewport = page.getViewport({ scale: 1 });
      var scale = Number(options.dpi) / 72;
      var longest = Math.max(baseViewport.width, baseViewport.height) * scale;
      if (options.maxEdge && longest > options.maxEdge) {
        scale *= Number(options.maxEdge) / longest;
      }
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      var context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('浏览器无法创建 canvas 画布');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport: viewport, background: '#ffffff' }).promise;
      var dataUrl = canvas.toDataURL(options.imageType, options.quality);
      return {
        page: number,
        dataUrl: dataUrl,
        width: canvas.width,
        height: canvas.height,
        bytes: dataUrlBytes(dataUrl),
        type: options.imageType
      };
    } finally {
      try { page.cleanup(); } catch (error) { /* ignore */ }
    }
  }

  // 渲染连续页码范围；默认最多 30 页，避免一次操作把内存吃满。
  async function renderRange(pdf, start, end, options) {
    options = Object.assign({}, DEFAULTS, options || {});
    start = Number(start);
    end = Number(end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new TypeError('页码范围必须是整数');
    }
    if (start < 1 || end < start || end > pdf.numPages) {
      throw new RangeError('页码范围无效：' + start + '-' + end);
    }
    if (end - start + 1 > options.maxRenderPages) {
      throw new RangeError('一次最多渲染 ' + options.maxRenderPages + ' 页');
    }
    var images = [];
    for (var number = start; number <= end; number += 1) {
      images.push(await renderPage(pdf, number, options));
      if (typeof options.onProgress === 'function') {
        options.onProgress({ page: number, done: number - start + 1, total: end - start + 1 });
      }
    }
    return images;
  }

  // 解析 “1-12” / “3” / “1—12” 这类页码范围。
  function parseRange(value, total, maxPages) {
    var text = String(value == null ? '' : value).trim().replace(/[–—~至]/g, '-');
    var match = text.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return null;
    var start = Number(match[1]);
    var end = match[2] ? Number(match[2]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 1 || end < start || end > total) return null;
    if (maxPages && end - start + 1 > maxPages) return null;
    return { start: start, end: end, count: end - start + 1 };
  }

  function dataUrlBytes(dataUrl) {
    var comma = String(dataUrl || '').indexOf(',');
    if (comma < 0) return 0;
    return Math.ceil((dataUrl.length - comma - 1) * 0.75);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var index = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);
    return (Number(bytes) / Math.pow(1024, index)).toFixed(index ? 1 : 0) + ' ' + units[index];
  }

  function base64ToBytes(dataUrl) {
    var comma = String(dataUrl || '').indexOf(',');
    if (comma < 0) throw new Error('不是有效的 data URL');
    var binary = atob(String(dataUrl).slice(comma + 1));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var index = 0; index < 256; index += 1) {
        var value = index;
        for (var bit = 0; bit < 8; bit += 1) {
          value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        crcTable[index] = value >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(array, offset, value) {
    array[offset] = value & 0xff;
    array[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeUint32(array, offset, value) {
    array[offset] = value & 0xff;
    array[offset + 1] = (value >>> 8) & 0xff;
    array[offset + 2] = (value >>> 16) & 0xff;
    array[offset + 3] = (value >>> 24) & 0xff;
  }

  // 不压缩 ZIP（图片本身已经压缩过）；只依赖浏览器，不引入 JSZip。
  function makeZip(files) {
    var encoder = new TextEncoder();
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var entries = [];
    var offset = 0;
    (files || []).forEach(function (file) {
      var name = encoder.encode(String(file.name || 'file.bin'));
      var data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || []);
      var crc = crc32(data);
      var header = new Uint8Array(30 + name.length);
      writeUint32(header, 0, 0x04034b50);
      writeUint16(header, 4, 20);
      writeUint16(header, 6, 0x0800);
      writeUint16(header, 8, 0);
      writeUint16(header, 10, dosTime);
      writeUint16(header, 12, dosDate);
      writeUint32(header, 14, crc);
      writeUint32(header, 18, data.length);
      writeUint32(header, 22, data.length);
      writeUint16(header, 26, name.length);
      writeUint16(header, 28, 0);
      header.set(name, 30);
      entries.push({ name: name, data: data, crc: crc, header: header, offset: offset });
      offset += header.length + data.length;
    });
    var centralSize = 0;
    entries.forEach(function (entry) {
      centralSize += 46 + entry.name.length;
    });
    var output = new Uint8Array(offset + centralSize + 22);
    var position = 0;
    entries.forEach(function (entry) {
      output.set(entry.header, position);
      position += entry.header.length;
      output.set(entry.data, position);
      position += entry.data.length;
    });
    var centralStart = position;
    entries.forEach(function (entry) {
      var header = new Uint8Array(46 + entry.name.length);
      writeUint32(header, 0, 0x02014b50);
      writeUint16(header, 4, 20);
      writeUint16(header, 6, 20);
      writeUint16(header, 8, 0x0800);
      writeUint16(header, 10, 0);
      writeUint16(header, 12, dosTime);
      writeUint16(header, 14, dosDate);
      writeUint32(header, 16, entry.crc);
      writeUint32(header, 20, entry.data.length);
      writeUint32(header, 24, entry.data.length);
      writeUint16(header, 28, entry.name.length);
      writeUint16(header, 30, 0);
      writeUint16(header, 32, 0);
      writeUint16(header, 34, 0);
      writeUint16(header, 36, 0);
      writeUint32(header, 38, 0);
      writeUint32(header, 42, entry.offset);
      header.set(entry.name, 46);
      output.set(header, position);
      position += header.length;
    });
    writeUint32(output, position, 0x06054b50);
    writeUint16(output, position + 4, 0);
    writeUint16(output, position + 6, 0);
    writeUint16(output, position + 8, entries.length);
    writeUint16(output, position + 10, entries.length);
    writeUint32(output, position + 12, centralSize);
    writeUint32(output, position + 16, centralStart);
    writeUint16(output, position + 20, 0);
    return new Blob([output], { type: 'application/zip' });
  }

  global.PdfTools = {
    DEFAULTS: DEFAULTS,
    configure: configure,
    openPdf: openPdf,
    extractText: extractText,
    renderPage: renderPage,
    renderRange: renderRange,
    parseRange: parseRange,
    dataUrlBytes: dataUrlBytes,
    formatBytes: formatBytes,
    base64ToBytes: base64ToBytes,
    makeZip: makeZip
  };
})(window);
