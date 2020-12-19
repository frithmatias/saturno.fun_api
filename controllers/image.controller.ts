import { Request, Response } from 'express';
import fileSystem from './filesystem.controller';
import fs from 'fs';
import path from 'path';

const http = require('http');
// getImage para obtener imagenes en un BACKEND con storage

function getImage2(req: Request, res: Response) {
    var id = req.params.id;
    var img = req.params.img;

    var pathImage = path.resolve(__dirname, `../uploads/${id}/${img}`);
    if (fs.existsSync(pathImage)) {
        res.sendFile(pathImage);
    } else {
        var pathNoImage = path.resolve(__dirname, '../assets/img/no-img.jpg');
        res.sendFile(pathNoImage);
    }
    // Ahora si para ver la imgen por HTTP 
    // http://localhost:3000/imagenes/usuarios/5dc87bd8d5756a191422c938/5dc87bd8d5756a191422c938-88.png
}

// El backend obtiene las imagnes de otro sitio 
// frontend <- [HTTP] <- backend <- [FTP] <- hostinger
async function getImage(req: Request, res: Response) {
    var idCompany = req.params.idCompany;
    var idType = req.params.idType;
    var idFile = req.params.idFile;
    // ../../ -> tengo que salir de la carpeta 'server' donde transpila TypeScript
    var pathImage = path.resolve(__dirname, `../../uploads/${idCompany}/${idType}/${idFile}`);
    if (fs.existsSync(pathImage)) {
        res.sendFile(pathImage);
    } else {
        var pathNoImage = path.resolve(__dirname, '../../assets/img/no-img.jpg');
        res.sendFile(pathNoImage);
    }
}

// Si el archivo no existe en Heroku lo busco en Hostinger.
function downloadHTTP(idCompany: string, idFile: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        // creo nuevamente la carpeta de usuario en Heroku
        fileSystem.createFolder(`./uploads/${idCompany}`);

        // hago la descarga de la imágen solicitada a heroku pero en Hostinger
        const url = `http://www.satruno.fun/uploads/${idCompany}/${idFile}`;

        var download = (url: string, dest: string) => {
            var file = fs.createWriteStream(dest);
            var request = http.get(url, (response: any) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close(); // close() is async, call cb after close completes.
                    resolve(true);
                });
                file.on('error', () => {
                    file.close(); // close() is async, call cb after close completes.
                    reject(false);
                });
            }).on('error', (err: any) => { // Manejo el error
                fs.unlink(dest, () => {
                }); // elimino el archivo asincronamente
                reject(err.message);
            });
        };

        download(url, `./uploads/${idCompany}/${idFile}`);
    });

}

export = { getImage };