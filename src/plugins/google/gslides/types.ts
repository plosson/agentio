export interface GSlidesCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
  email: string;
}

export interface GSlidesListOptions {
  limit?: number;
  query?: string;
}

export interface GSlidesListItem {
  id: string;
  title: string;
  owner?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink: string;
}

export interface GSlidesSlideInfo {
  index: number;
  objectId: string;
  title?: string;
}

export interface GSlidesPresentation {
  id: string;
  title: string;
  url: string;
  slideCount: number;
  width?: number;
  height?: number;
  slides: GSlidesSlideInfo[];
}

export interface GSlidesElement {
  type: 'text';
  text: string;
}

export interface GSlidesSlideContent {
  index: number;
  objectId: string;
  elements: GSlidesElement[];
  notes: string;
}

export interface GSlidesCreateResult {
  id: string;
  title: string;
  url: string;
}

export interface GSlidesBatchResult {
  replies: number;
  presentationId: string;
}
