// Generic Amazon product interfaces — tool-agnostic

export interface AmazonProduct {
  asin: string;
  title?: string;
  brand?: string;
  buybox_winner?: { price?: { value?: number } };
  rating?: number;
  ratings_total?: number;
  reviews_total?: number;
  main_image?: { link?: string };
  link?: string;
  bestsellers_rank?: { rank?: number; category?: string; link?: string }[];
  also_bought?: { asin: string; title?: string }[];
  keywords?: string;
}

export interface AmazonBestseller {
  rank?: number;
  asin: string;
  title?: string;
  brand?: string;
  rating?: number;
  ratings_total?: number;
  price?: { value?: number };
}

export interface AmazonSearchResult {
  asin: string;
  title?: string;
  ratings_total?: number;
}
