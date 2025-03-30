import JsZip from 'jszip'
import Moment from 'moment'

const MIME_MAP = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['image/avif', 'avif'],
  ['application/octet-stream', 'bin'],
])

const createUuid = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

class Volume {
  private epub: EpubSaver
  public title: string
  public idx: number
  public chapters: any[]
  public containerFile: string

  constructor(epub: EpubSaver, title: string, idx: number) {
    this.epub = epub
    this.title = title
    this.idx = idx
    this.chapters = []
    this.containerFile = `volume_${idx}.xhtml`
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
</body>
</html>`
    this.epub._addResource(this.containerFile, new TextEncoder().encode(content))
  }

  private wrapContent(content: string, title: string, contentType: string, insertTitle: boolean) {
    if (contentType === 'text') {
      return `<pre>${insertTitle ? `<h1>${title}</h1>` : ''}${content}</pre>`
    }
    if (contentType === 'html' && insertTitle) {
      return `<h1>${title}</h1>${content}`
    }
    return content
  }
  private registerResources(resources: [string, string, Uint8Array][]) {
    resources.forEach(([url, path, data]) => {
      this.epub.resourceUrls.set(url, path)
      this.epub._addResource(path, data)
    })
  }
  private buildXhtml(content1: string, title: string, useGlobalCSS: boolean, cssList: number[]) {
    const cssLinks = []

    if (useGlobalCSS) {
      const globalCSS = this.epub.cssList.find(c => c.idx === 0)
      if (globalCSS) cssLinks.push(globalCSS)
    }

    cssList.forEach(idx => {
      const css = this.epub.cssList.find(c => c.idx === idx)
      if (css) cssLinks.push(css)
    })
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta name="viewport" content="width=device-width, height=device-height, initial-scale=1.0"/>
<title>${this.escapeXml(title)}</title>
${cssLinks.map(c => `<link href="${c.filename}" rel="stylesheet"/>`).join('\n  ')}
</head>
<body>
${this.extractContent(content1)}
</body>
</html>`
  }
  private getExtension(mimeType: string, url: string) {
    const fromMime = MIME_MAP.get(mimeType) || mimeType.split('/').pop()
    const fromUrl = url.split(/[#?]/)[0].split('.').pop()
    return (fromMime || fromUrl || 'bin').toLowerCase()
  }
  private escapeXml(str: string) {
    return str.replace(/[<>&'"]/g, c => {
      return (
        {
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;',
          "'": '&apos;',
          '"': '&quot;',
        }[c] ?? ''
      )
    })
  }
  private extractContent(html: string) {
    try {
      const articleMatch = html.match(/<article>([\s\S]*?)<\/article>/i)
      if (articleMatch) return articleMatch[1]

      const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/i)
      if (bodyMatch) return bodyMatch[1]

      return html
    } catch (e) {
      console.warn('内容解析失败，使用原始内容', e)
      return html
    }
  }

  async addChapter(
    idx: number,
    content: string,
    title: string,
    contentType: string,
    insertTitle = true,
    useGlobalCSS = true,
    cssList = []
  ) {
    const chapD = this.extractContent(content)
    // 内容预处理
    const processed = this.wrapContent(chapD, title, contentType, insertTitle)
    // 图片处理
    const { content: finalContent, resources } = await this.processImages(processed)
    // 资源注册
    this.registerResources(resources)
    // 构建 XHTML
    const xhtml = this.buildXhtml(finalContent, title, useGlobalCSS, cssList)
    const filename = `chapter_${this.idx}_${idx}.xhtml`

    this.epub._addResource(filename, new TextEncoder().encode(xhtml))
    this.chapters.push({ idx, title, filename })

    return idx
  }

  async processImages(content: string) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(content, 'text/html')
    const images = doc.querySelectorAll('img')
    const resources: [string, string, Uint8Array][] = []

    await Promise.all(
      Array.from(images).map(async img => {
        let url = img.getAttribute('src')
        if (!url || this.epub.resourceUrls.has(url)) return
        try {
          if (!url.startsWith('http')) {
            throw new Error('img src is not an url')
          }
          if (url.startsWith('http://') && window.location.href.startsWith('https://')) {
            console.warn(
              'DeprecationWarning:',
              'Mixed content warning: image is transported by unsafe protocol "http"',
              'try upgrade to https'
            )
            url = url.replace('http://', 'https://')
          }
          const response = await fetch(url)

          if (!response.ok) throw new Error(`HTTP ${response.status}`)

          // 类型识别
          const contentType = response.headers.get('Content-Type') || 'application/octet-stream'
          const [mimeType] = contentType.split(';')
          const ext = this.getExtension(mimeType, url)

          // 二进制处理
          const arrayBuffer = await response.arrayBuffer()
          const filename = `images/img${this.epub.resourceCounters.image++}.${ext}`

          img.setAttribute('src', filename)
          resources.push([url, filename, new Uint8Array(arrayBuffer)])
        } catch (e) {
          console.warn(`Image processing failed: ${url}`, e)
          img.remove() // 自动移除无效图片
        }
      })
    )

    // 序列化处理
    const serializer = new XMLSerializer()
    let processed = serializer.serializeToString(doc.documentElement).replace(/^<div>|<\/div>$/g, '') // 移除包装 div

    return { content: processed, resources }
  }
}

export default class EpubSaver {
  private resources: Map<string, Uint8Array>
  private volumes: Volume[]
  private cssMap: Map<string, number>
  private info: any
  private uuid: string
  public resourceCounters: { image: number; css: number; other: number }
  public resourceUrls: Map<string, string>
  public cssList: { idx: number; filename: string; mapname: string }[]

  constructor() {
    this.resources = new Map()
    this.resourceUrls = new Map()
    this.volumes = []
    this.cssList = []
    this.cssMap = new Map()
    this.info = {}
    this.uuid = createUuid()
    this.resourceCounters = { image: 0, css: 0, other: 0 }
  }

  _addResource(path: string, content: Uint8Array) {
    if (!this.resources.has(path)) {
      this.resources.set(path, content)
    }
  }

  async setInfo(tag: string, value: Uint8Array | string) {
    switch (tag) {
      case 'cover':
        if (typeof value === 'string') {
          const response = await fetch(value)
          const blob = await response.blob()
          const arrayBuffer = await blob.arrayBuffer()
          value = new Uint8Array(arrayBuffer)
        }
        this.info.cover = value
        break
      default:
        this.info[tag] = value
        break
    }
  }

  addVolume(title: string, idx: number) {
    const volume = new Volume(this, title, idx)
    this.volumes.push(volume)
    return volume
  }

  private async processCSSUrls(css: string) {
    const urlRegex = /url\(\s*['"]?(.*?)['"]?\s*\)/g
    const replacements = []

    let match
    while ((match = urlRegex.exec(css)) !== null) {
      const url = match[1]
      if (!this.resourceUrls.has(url)) {
        try {
          const response = await fetch(url)
          const blob = await response.blob()
          const arrayBuffer = await blob.arrayBuffer()
          const ext = url.split('.').pop()!.split(/[#?]/)[0] || 'bin'
          const filename = `resources/res${this.resourceCounters.other++}.${ext}`
          this._addResource(filename, new Uint8Array(arrayBuffer))
          this.resourceUrls.set(url, filename)
        } catch (e) {
          console.warn('Failed to fetch CSS resource:', url)
        }
      }
      replacements.push([url, this.resourceUrls.get(url) || url])
    }

    return replacements.reduce(
      (acc, [url, path]) => acc.replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), path),
      css
    )
  }
  async addCSS(idx: number, content: string, filename: string, mapname: string) {
    let cssContent = content

    if (typeof content === 'string' && /^https?:\/\//.test(content)) {
      const response = await fetch(content)
      cssContent = await response.text()
    }
    cssContent = await this.processCSSUrls(cssContent)

    if (!filename) filename = `Styles/style${this.resourceCounters.css++}.css`

    this._addResource(filename, new TextEncoder().encode(cssContent))
    this.cssList.push({ idx, filename, mapname })

    if (mapname) this.cssMap.set(mapname, idx)

    return idx
  }
  async createCSSMap(map: Record<string, string>) {
    const results: Record<string, number> = {}
    let maxIdx = Math.max(...this.cssList.map(c => c.idx), 0)
    for (const [mapname, content] of Object.entries(map)) {
      const idx = ++maxIdx
      await this.addCSS(idx, content, mapname, mapname)
      results[mapname] = idx
    }
    return results
  }

  private generateNcx() {
    let playOrder = 1
    const navPoints: string[] = []

    this.volumes
      .sort((a, b) => a.idx - b.idx)
      .forEach(vol => {
        // 为每个卷创建容器navPoint（不设置具体内容）
        const volumePoint = `
<navPoint id="navpoint-${playOrder}" playOrder="${playOrder++}">
  <navLabel><text>${vol.title}</text></navLabel>
  <content src="${vol.containerFile || vol.chapters[0]?.filename}"/>`

        // 创建章节navPoint
        const chapterPoints = vol.chapters
          .sort((a, b) => a.idx - b.idx)
          .map(
            chap => `
    <navPoint id="navpoint-${playOrder}" playOrder="${playOrder++}">
      <navLabel><text>${chap.title}</text></navLabel>
      <content src="${chap.filename}"/>
    </navPoint>`
          )
          .join('')

        navPoints.push(`${volumePoint}${chapterPoints}</navPoint>`)
      })

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="urn:uuid:${this.uuid}"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle>
<text>${this.info.bookname || 'Untitled'}</text>
</docTitle>
<navMap>
${navPoints.join('')}
</navMap>
</ncx>`
  }
  private generateOpf() {
    const metadata = [
      `<dc:identifier id="BookId">urn:uuid:${this.uuid}</dc:identifier>`,
      `<dc:title>${this.info.bookname || 'Untitled'}</dc:title>`,
      `<dc:creator>${this.info.author || 'Unknown'}</dc:creator>`,
      `<dc:description>${this.info.introduction || ''}</dc:description>`,
      `<dc:language>zh-CN</dc:language>`,
      `<meta property="dcterms:modified">${Moment(Date.now()).utc().format('YYYY-MM-DDTHH:mm:ss')}Z</meta>`,
    ]

    // 增强封面处理
    if (this.info.cover) {
      metadata.push(
        `<meta name="cover" content="cover-image"/>`,
        `<meta property="rendition:layout">pre-paginated</meta>`
      )
      this._addResource('images/cover.jpg', this.info.cover)

      // 添加封面XHTML页面
      const coverHtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta name="viewport" content="width=device-width, height=device-height, initial-scale=1.0, minimum-scale=1.0"/>
<title>Cover</title>
</head>
<body>
<div style="text-align: center; padding: 0pt; margin: 0pt;">
<img src="images/cover.jpg" alt="Cover Image" style="height: 100%; max-width: 100%;"/>
</div>
</body>
</html>`
      this._addResource('cover.xhtml', new TextEncoder().encode(coverHtml))
    }

    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    ]

    if (this.info.cover) {
      manifest.push(
        '<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
        '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>'
      )
    }

    this.resources.forEach((_, path) => {
      const id = path.replace(/[^a-z0-9]/gi, '-')
      let type = 'application/octet-stream'
      if (path.endsWith('.xhtml')) type = 'application/xhtml+xml'
      else if (path.endsWith('.css')) type = 'text/css'
      else if (path.match(/\.jpe?g$/)) type = 'image/jpeg'
      else if (path.endsWith('.png')) type = 'image/png'
      manifest.push(`<item id="${id}" href="${path}" media-type="${type}"/>`)
    })

    const spine = []
    if (this.info.cover) {
      spine.push('<itemref idref="cover"/>')
    }
    this.volumes
      .sort((a, b) => a.idx - b.idx)
      .forEach(v => {
        v.chapters
          .sort((a, b) => a.idx - b.idx)
          .forEach(c => {
            spine.push(`<itemref idref="${c.filename.replace(/[^a-z0-9]/gi, '-')}"/>`)
          })
      })

    const guide = this.info.cover ? `<reference href="cover.xhtml" type="cover" title="Cover"/>` : ''

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadata.join('\n    ')}
</metadata>
<manifest>
${manifest.join('\n    ')}
</manifest>
<spine toc="ncx">
${spine.join('\n    ')}
</spine>
<guide>
${guide}
</guide>
</package>`
  }
  private generateNav() {
    const items = this.volumes
      .sort((a, b) => a.idx - b.idx)
      .map(
        v => `
<li>
  <a href="${v.chapters[0]?.filename || ''}">${v.title}</a>
  <ol>
    ${v.chapters
      .sort((a, b) => a.idx - b.idx)
      .map(
        c => `
      <li><a href="${c.filename}">${c.title}</a></li>
    `
      )
      .join('')}
  </ol>
</li>
`
      )
      .join('')

    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<title>Table of Contents</title>
</head>
<body>
<nav epub:type="toc">
<h1>Table of Contents</h1>
<ol>
${items}
</ol>
</nav>
</body>
</html>`
  }
  async save() {
    const zip = new JsZip()

    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

    const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`
    zip.folder('META-INF')!.file('container.xml', container)

    const opf = this.generateOpf()
    zip.folder('OEBPS')!.file('content.opf', opf)
    const ncxContent = this.generateNcx()
    zip.folder('OEBPS')!.file('toc.ncx', ncxContent)

    this.resources.forEach((content, path) => {
      zip.folder('OEBPS')!.file(path, content)
    })

    const nav = this.generateNav()
    zip.folder('OEBPS')!.file('nav.xhtml', nav)

    return zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    })
  }
}
