# Walkipedia

Every Wikipedia article within a short walk, pinned on a map. Search for a place or share your location.

Live at [neil-scott.com/walkipedia](https://www.neil-scott.com/walkipedia/).

## Running it

It's a static page with no build step. Serve the folder with any web server, for example:

```sh
npx serve .
```

After editing `css/style.css`, `js/app.js` or the SVGs, run `./bust-cache.sh` to update the cache-busting hashes in `index.html`.

`index.html` also loads `/js/newsletter.js` from the main site. It isn't included here; the newsletter form works without it.

## How it works

- Articles come from the Wikipedia geosearch API, in any of 16 language editions, with types guessed from Wikidata short descriptions.
- Places are searched with [Nominatim](https://nominatim.org/) and [postcodes.io](https://postcodes.io/), with [Photon](https://photon.komoot.io/) as a backup.
- The map uses [Leaflet](https://leafletjs.com/) and [MapLibre](https://maplibre.org/), with tiles from [OpenFreeMap](https://openfreemap.org/) and [OpenStreetMap](https://www.openstreetmap.org/copyright).

If you deploy your own copy, follow the usage policies of these services, particularly [Nominatim's](https://operations.osmfoundation.org/policies/nominatim/).

Inspired by [Local Wikipedia](https://edjefferson.com/localwiki/) by Ed Jefferson.

## Licence

The code is [MIT](LICENSE). The map libraries in `vendor/` (Leaflet, Leaflet.markercluster, MapLibre GL JS and MapLibre GL Leaflet) are under their own licences, included alongside them. Article text belongs to Wikipedia contributors under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The Nunito font is under the [SIL Open Font License](fonts/OFL.txt).

The Walkipedia name, wordmark and icons aren't covered by the MIT licence. If you deploy a fork, please use your own.
