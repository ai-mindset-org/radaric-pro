export interface OnboardingState {
  version: 1
  step: 'import' | 'parsing' | 'unresolved' | 'review' | 'preferences'
  extractedFeeds: ExtractedFeed[]
  inputText?: string
  inputFile?: string
}

export interface ExtractedFeed {
  url: string | null
  name: string
  type: 'RSS' | 'TELEGRAM' | 'TWITTER' | 'YOUTUBE' | 'WEBSITE'
  status: 'pending' | 'found' | 'not_found'
  feedUrl?: string
  recentHeadline?: string
}
