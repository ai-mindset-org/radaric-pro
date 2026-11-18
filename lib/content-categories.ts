export const LIKED_CATEGORIES = [
  "Articles",
  "Tutorials",
  "Case Studies",
  "Product Updates",
  "Industry News",
  "Podcasts",
  "Research",
  "Interviews",
  "Tools & Resources",
  "Expert Opinions",
  "Open Source",
  "Product Launches",
] as const

export const DISLIKED_CATEGORIES = [
  "Ads",
  "Self-promotion",
  "Sponsored",
  "Clickbait",
  "Off-topic",
  "Outdated",
  "Repetitive",
  "Low Quality",
  "Listicles",
  "Paywalled",
] as const

export type LikedCategory = (typeof LIKED_CATEGORIES)[number]
export type DislikedCategory = (typeof DISLIKED_CATEGORIES)[number]
