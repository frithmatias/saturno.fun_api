const CACHE_STATIC = 'static-0.8'
const CACHE_DYNAMIC = 'dynamic-0.8'
const CACHE_INMUTABLE = 'inmutable-0.8'

// ----------------------------------------------------------
// app shell
// ----------------------------------------------------------

self.addEventListener('install', e => {
  let static = caches
    .open(CACHE_STATIC)
    .then(cache => {
      // waitUntil espera una promesa por lo tanto tengo que usar RETURN
      return cache.addAll([
        '/',
        '/1.9feead0338faa404a4fe.js',
        '/5.bf956a16ffa6c01ebf53.js',
        '/6.29eb4445c030fdc256c3.js',
        '/7.db66503bc1d41c8248c5.js',
        '/8.fb85cc393f48b40708e5.js',
        '/9.b164763ab1f028cd5d07.js',
        '/angular.5d5e9d7ac83c39d0c2bd.svg',
        '/beer.91e496f27f840ac8f95e.svg',
        '/bghome.2374cce18f9d245fa1a9.jpg',
        '/cup.e1f5187976b0bae910b5.svg',
        '/heroku.b7e7f910d905c15ac7d6.svg',
        '/javascript.073149757fbeb5b24d7f.svg',
        '/main.ec13d540915c873036b8.js',
        '/mongodb2.fa3a3b8ab3c3f12f2e39.svg',
        '/nodejs.615ffbea9529ca7047ed.svg',
        '/polyfills.e95903275e33ac0ccdfb.js',
        '/restaurant.3ad69415a1b2164b2b2d.svg',
        '/runtime.34645d9f6795982f7138.js',
        '/styles.9bc9dbfc5a90c8521c39.css',
        '/typescript.a6305a733dd55243980a.svg',
      ])
    })
    .catch(() => {
      console.log('error al crear la app shell')
    })

  let inmutable = caches
    .open(CACHE_INMUTABLE)
    .then(cache => {
      return cache.addAll([
        '/app.js',
        '/favicon.ico',
        '/manifest.json',
        '/assets/pwa.css',
        '/assets/bell.wav',
        '/assets/img/map/duff-beer.svg',
        '/assets/img/icons/logo72x72.png',
        '/assets/img/icons/logo96x96.png',
        '/assets/img/icons/logo128x128.png',
        '/assets/img/icons/logo144x144.png',
        '/assets/img/icons/logo152x152.png',
        '/assets/img/icons/logo192x192.png',
        '/assets/img/icons/logo384x384.png',
        '/assets/img/icons/logo512x512.png',
        '/assets/img/icons-ios/apple-launch-640x1136.png',
        '/assets/img/icons-ios/apple-launch-750x1334.png',
        '/assets/img/icons-ios/apple-launch-1125x2436.png',
        '/assets/img/icons-ios/apple-launch-1242x2208.png',
      ])
    })
    .catch(() => {
      console.log('error al crear el cache inmutable')
    })

  e.waitUntil(Promise.all([inmutable, static]))
})

// ----------------------------------------------------------
// delete old static cache
// ----------------------------------------------------------
self.addEventListener('activate', e => {
  const respuesta = caches.keys().then(keys => {
    keys.forEach(key => {
      if (key !== CACHE_STATIC && key.includes('static')) {
        return caches.delete(key)
      }
    })
  })
  e.waitUntil(respuesta)
})

// ----------------------------------------------------------
// 2. Strategy: Cache with network fallback
// ----------------------------------------------------------

self.addEventListener('fetch', e => {
  if (
    e.request.url.includes('saturno') ||
    e.request.url.includes('herokuapp') ||
    e.request.url.includes('localhost')
  ) {
    // las peticiones GET no debe guardarlas en cache
    const respuesta = fetch(e.request).then(resp => {
      return resp
    })
    e.respondWith(respuesta)
  } else {
    const respuesta = caches
      .match(e.request)
      .then(resp => {
        if (resp) {
          return resp
        }
        return fetch(e.request).then(resp => {
          if (e.request.method !== 'POST') {
            caches.open(CACHE_DYNAMIC).then(cache => {
              cache.put(e.request, resp.clone())
            })
          }
          return resp.clone()
        })
      })
      .catch(err => {
        if (e.request.headers.get('accept').includes('text/html')) {
          return caches.match('/offline.html')
        }
      })
    e.respondWith(respuesta)
  }
})

// escuchar push
self.addEventListener('push', e => {
  const data = JSON.parse(e.data.text())
  const title = data.title
  const msg = data.msg

  const options = {
    body: msg,
    vibrate: [
      0,
      300,
      100,
      50,
      100,
      50,
      100,
      50,
      100,
      50,
      100,
      50,
      100,
      50,
      150,
      150,
      150,
      450,
      100,
      50,
      100,
      50,
      150,
      150,
      150,
      450,
      100,
      50,
      100,
      50,
      150,
      150,
      150,
      450,
      150,
      150
    ],
    icon: 'assets/img/icons/icon-72x72.png',
    badge: 'img/favicon.ico',
    openUrl: 'https://saturno.fun',
    data: {
      url: 'https://saturno.fun'
    },
    actions: [
      // solo permite dos acciones válidas se muestran como BOTONES en la notificación.
      {
        action: 'ver-pantalla',
        title: 'Ver Pantalla'
        // icon: 'assets/avatars/thor.jpg'
      },
      {
        action: 'obtener-turno',
        title: 'Obtener Turno'
        // icon: 'assets/avatars/ironman.jpg'
      }
    ]
  }
  // como toda accion en el SW tengo que esperar a que termine de realizar toda la notificación
  // porque puede demorar unos segundos.
  e.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', e => {
  const notificacion = e.notification
  const accion = e.action
  notificacion.close()
})

self.addEventListener('notificationclick', e => {
  const notificacion = e.notification
  const accion = e.action
  //matchAll() busca en todas las pestañas abiertas del mismo sitio, y regresa una promesa
  const respuesta = clients.matchAll().then(clientes => {
    // clientes es un array de todos los tabs abiertos de mi aplicación yo sólo quiero el que se encuentra visible
    let cliente = clientes.find(c => {
      return c.visibilityState === 'visible'
    })
    if (cliente !== undefined) {
      cliente.navigate(notificacion.data.url)
      cliente.focus()
    } else {
      clients.openWindow(notificacion.data.url) // me abre una nueva pestaña pero no es lo que yo quiero
    }
    return notificacion.close()
  })
  e.waitUntil(respuesta)
})
