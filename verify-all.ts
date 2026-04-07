

const COUNTRY_CATEGORY_PATHS: Record<string, Record<string, string>> = {
  electronics: {
    US: 'electronics', UK: 'electronicswa', CA: 'electronics',
    DE: 'ce-de', FR: 'electronics', IT: 'electronics',
    ES: 'electronics', IN: 'electronics', JP: 'electronics', AU: 'electronics',
  },
  kitchen: {
    US: 'kitchen', UK: 'kitchen', CA: 'kitchen',
    DE: 'kitchen', FR: 'cuisine', IT: 'cucina',
    ES: 'cocina', IN: 'kitchen', JP: 'kitchen', AU: 'kitchen',
  },
  beauty: {
    US: 'beauty', UK: 'beauty', CA: 'beauty',
    DE: 'beauty', FR: 'beauty', IT: 'beauty',
    ES: 'beauty', IN: 'beauty', JP: 'beauty', AU: 'beauty',
  },
  toys: {
    US: 'toys-and-games', UK: 'kids-and-toys', CA: 'toys',
    DE: 'spielzeug', FR: 'jouets-et-jeux', IT: 'giochi-e-giocattoli',
    ES: 'juguetes-y-juegos', IN: 'toys', JP: 'toys', AU: 'toys',
  },
  sports: {
    US: 'sporting-goods', UK: 'sports-outdoors', CA: 'sports',
    DE: 'sport', FR: 'sports-et-loisirs', IT: 'sport',
    ES: 'deportes-y-aire-libre', IN: 'sports-fitness-and-outdoors', JP: 'sports', AU: 'sports',
  },
  clothing: {
    US: 'fashion', UK: 'clothing', CA: 'clothing-shoes-and-accessories',
    DE: 'fashion', FR: 'mode', IT: 'moda',
    ES: 'moda', IN: 'apparel', JP: 'fashion', AU: 'fashion',
  },
  health: {
    US: 'hpc', UK: 'drugstore', CA: 'hpc',
    DE: 'drogerie', FR: 'hygiene-et-sante', IT: 'salute-e-cura-della-persona',
    ES: 'salud-y-cuidado-personal', IN: 'hpc', JP: 'hpc', AU: 'health',
  },
  home: {
    US: 'home-garden', UK: 'home-garden', CA: 'home',
    DE: 'kueche-haushalt-wohnen', FR: 'maison', IT: 'casa-e-cucina',
    ES: 'hogar-y-cocina', IN: 'home-improvement', JP: 'home', AU: 'home',
  },
  books: {
    US: 'books', UK: 'books', CA: 'books',
    DE: 'buecher', FR: 'livres', IT: 'libri',
    ES: 'libros', IN: 'books', JP: 'books', AU: 'books',
  },
  grocery: {
    US: 'grocery', UK: 'grocery', CA: 'grocery',
    DE: 'lebensmittel', FR: 'epicerie', IT: 'alimentari-e-cura-della-casa',
    ES: 'alimentacion', IN: 'grocery', JP: 'food-beverage', AU: 'pantry',
  },
  office: {
    US: 'office-products', UK: 'office-products', CA: 'office-products',
    DE: 'burobedarf-schreibwaren', FR: 'fournitures-de-bureau', IT: 'cancelleria-e-prodotti-per-ufficio',
    ES: 'oficina-y-papeleria', IN: 'office-products', JP: 'office-products', AU: 'office-products',
  },
  petSupplies: {
    US: 'pet-supplies', UK: 'pet-supplies', CA: 'pet-supplies',
    DE: 'haustier', FR: 'animalerie', IT: 'prodotti-per-animali-domestici',
    ES: 'productos-para-mascotas', IN: 'pet-supplies', JP: 'pet-supplies', AU: 'pets',
  },
  automotive: {
    US: 'automotive', UK: 'automotive', CA: 'automotive',
    DE: 'auto-und-motorrad', FR: 'auto-et-moto', IT: 'auto-e-moto',
    ES: 'coche-y-moto', IN: 'car-motorbike', JP: 'automotive', AU: 'automotive',
  },
  baby: {
    US: 'baby-products', UK: 'baby-products', CA: 'baby',
    DE: 'baby', FR: 'bebes-et-puericulture', IT: 'prima-infanzia',
    ES: 'bebe', IN: 'baby', JP: 'baby', AU: 'baby',
  },
  tools: {
    US: 'hi', UK: 'diy-tools', CA: 'hi',
    DE: 'baumarkt', FR: 'bricolage', IT: 'fai-da-te',
    ES: 'bricolaje-y-herramientas', IN: 'home-improvement', JP: 'diy', AU: 'home-improvement',
  },
  videogames: {
    US: 'videogames', UK: 'videogames', CA: 'videogames',
    DE: 'videogames', FR: 'jeux-video', IT: 'videogiochi',
    ES: 'videojuegos', IN: 'videogames', JP: 'videogames', AU: 'videogames',
  },
};

const TLD_MAP: Record<string, string> = {
  US: 'amazon.com',
  UK: 'amazon.co.uk',
  CA: 'amazon.ca',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  ES: 'amazon.es',
  IN: 'amazon.in',
  JP: 'amazon.co.jp',
  AU: 'amazon.com.au',
};

async function checkUrl(url: string, lang: string): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': lang,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      }
    });
    if (!res.ok) return -1;
    const text = await res.text();
    const count = (text.match(/data-asin=/g) || []).length;
    return count;
  } catch (e) {
    return -1;
  }
}

// Check some key countries and categories
const countriesList = ['DE', 'FR', 'IT', 'ES', 'CA', 'UK'];
const cats = Object.keys(COUNTRY_CATEGORY_PATHS);

async function main() {
  console.log(`Starting massive verification of ${countriesList.length * cats.length} paths...`);
  const failedList: string[] = [];

  for (let c = 0; c < countriesList.length; c++) {
    const country = countriesList[c];
    const tld = TLD_MAP[country];
    const lang = country === 'DE' ? 'de-DE,de;q=0.9' : country === 'FR' ? 'fr-FR,fr;q=0.9' : country === 'IT' ? 'it-IT,it;q=0.9' : country === 'ES' ? 'es-ES,es;q=0.9' : 'en-US,en;q=0.9';
    
    console.log(`\n\n=== Verifying ${country} (${tld}) ===`);
    const results: string[] = [];
    
    // Process in batches of 4
    for (let i = 0; i < cats.length; i += 4) {
      const batch = cats.slice(i, i + 4);
      const promises = batch.map(async (cat) => {
        const path = COUNTRY_CATEGORY_PATHS[cat][country];
        const url = `https://www.${tld}/gp/bestsellers/${path}/`;
        const count = await checkUrl(url, lang);
        
        let status = '';
        if (count >= 10) {
          status = `✅ [${cat}] ${path}: ${count} products`;
        } else {
          status = `❌ [${cat}] ${path}: FAILED (${count} products)`;
          failedList.push(`${country} -> ${cat} (Path: ${path})`);
        }
        return status;
      });
      
      const res = await Promise.all(promises);
      results.push(...res);
      await new Promise(r => setTimeout(r, 1000)); // anti-rate-limit
    }
    
    results.forEach(r => console.log(r));
  }
  
  if (failedList.length > 0) {
    console.log('\n\n🚨 FAILURES DETECTED:');
    failedList.forEach(f => console.log(f));
  } else {
    console.log('\n\n✅ ALL PERFECT! 100% of paths verified to contain real products.');
  }
}

main();
