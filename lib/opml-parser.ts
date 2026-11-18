import { Parser } from "xml2js"

export interface OpmlFeed {
  name: string
  xmlUrl: string
  htmlUrl?: string
  group?: string
  isFeedlySpecific: boolean
}

const FEEDLY_PATTERNS = [
  /^https?:\/\/feedly\.com\/web\//,
  /^https?:\/\/feedproxy\.feedly\.com\//,
  /^https?:\/\/feedly\.com\/f\/alert\//,
]

function isFeedlyUrl(url: string): boolean {
  return FEEDLY_PATTERNS.some((pattern) => pattern.test(url))
}

interface OutlineAttrs {
  text?: string
  title?: string
  xmlUrl?: string
  htmlUrl?: string
  type?: string
}

interface OutlineNode {
  $?: OutlineAttrs
  outline?: OutlineNode[]
}

function processOutline(node: OutlineNode, group: string | undefined): OpmlFeed[] {
  const attrs = node.$ ?? {}
  const xmlUrl = attrs.xmlUrl

  // This node itself is a feed
  if (xmlUrl && xmlUrl.trim() !== "") {
    const name = attrs.text ?? attrs.title ?? ""
    const feed: OpmlFeed = {
      name,
      xmlUrl: xmlUrl.trim(),
      isFeedlySpecific: isFeedlyUrl(xmlUrl.trim()),
    }
    if (attrs.htmlUrl) feed.htmlUrl = attrs.htmlUrl
    if (group !== undefined) feed.group = group
    return [feed]
  }

  // This node is a group — recurse into children
  const children = node.outline ?? []
  const groupName = attrs.text ?? attrs.title
  const feeds: OpmlFeed[] = []
  for (const child of children) {
    feeds.push(...processOutline(child, groupName))
  }
  return feeds
}

export function parseOpml(xmlString: string): OpmlFeed[] {
  const parser = new Parser({ explicitArray: true, attrkey: "$" })

  let result: any = null
  let parseError: Error | null = null

  parser.parseString(xmlString, (err: Error | null, res: any) => {
    if (err) {
      parseError = err
    } else {
      result = res
    }
  })

  if (parseError !== null) {
    throw new Error(`Failed to parse OPML: ${(parseError as Error).message}`)
  }

  if (!result || !result.opml) {
    throw new Error("Invalid OPML: missing <opml> root element")
  }

  const body = result.opml.body?.[0]
  if (!body) {
    return []
  }

  const topLevelOutlines: OutlineNode[] = body.outline ?? []
  const feeds: OpmlFeed[] = []

  for (const node of topLevelOutlines) {
    feeds.push(...processOutline(node, undefined))
  }

  if (feeds.length > 500) {
    throw new Error(`OPML contains ${feeds.length} feeds (max 500). Please split into smaller files.`)
  }

  return feeds
}
