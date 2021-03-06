import { Request, Response } from 'express';
import { Company } from '../models/company.model';

import fileSystem from './filesystem.controller';
import fs from 'fs';
const ftp = require("basic-ftp")

import environment from '../global/environment.prod';
import { User } from '../models/user.model';
import path from 'path';
import sharp from 'sharp';

// ========================================================
// Upload Methods
// ========================================================

async function uploadImagen(req: any, res: Response) {

    // ==============================================================
    // START FILE VERIFICATIONS
    // ==============================================================

    var idField = req.params.idField;
    var idDocument = req.params.idDocument;
    var idFieldsValid = ["tx_company_images", "tx_company_cover", "tx_company_logo", "tx_img"];

    if (!idFieldsValid.includes(idField)) {
        return res.status(400).json({
            ok: false,
            msg: "Error, tipo de imagen no valida.",
            filename: null
        });
    }

    if (!req.files) {
        return res.status(500).json({
            ok: false,
            msg: "Error no hay archivos para subir.",
            filename: null
        });
    }

    if (!req.files.imagen?.size || req.files.imagen?.size > 5242880) {
        return res.status(400).json({
            ok: false,
            msg: 'El archivo no debe superar los 5Mb',
            filename: null
        })
    }

    // Obtener nombre del archivo1
    var archivo = req.files.imagen; //'imagen' es el nombre dado en body>form-data en POSTMAN
    var archivoPartes = archivo.name.split(".");
    var archivoExtension = archivoPartes[archivoPartes.length - 1];

    // extensiones permitidas
    var extensionesValidas = ["png", "jpg", "gif", "jpeg"];

    if (!extensionesValidas.includes(archivoExtension)) {
        return res.status(400).json({
            // ERROR DE BASE DE DATOS
            ok: false,
            msg: "Error, extension de archivo no valida.",
            filename: null
        });
    }

    var fileName = `${+ new Date()}.${archivoExtension}`;

    // ==============================================================
    // SAVE FILE IN FILESYSTEM
    // ==============================================================

    var dirPath = `./uploads/${idDocument}/${idField}`;
    var absoluteDirPath = path.resolve(__dirname, '../', dirPath);
    fileSystem.createFolder(absoluteDirPath);
    let filePath = `${absoluteDirPath}/${fileName}`;
    await archivo.mv(filePath, (err: any) => {

        if (err) {
            return res.status(500).json({
                ok: false,
                msg: "Error, no se pudo guardar el archivo.",
                filename: fileName
            });
        }

        // ==============================================================
        // SAVE THUMBNAIL IN FILESYSTEM
        // ==============================================================

        sharp(filePath)
            .rotate()
            .resize(300)
            .jpeg({ mozjpeg: true })
            .toBuffer()
            .then(async (fileThumb) => {

                fs.writeFileSync(`${absoluteDirPath}/thumb-${fileName}`, fileThumb);

                // ==============================================================
                // SAVE IMAGE IN DB
                // ==============================================================

                saveDB(idField, idDocument, fileName, res).then(async (resp: any) => {
                    if (!resp.ok) {
                        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
                        return res.status(400).json(resp)
                    }
                    return res.status(200).json(resp);
                }).catch((resp) => {
                    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
                    return res.status(400).json(resp)
                })
                
            })
            .catch(err => {
                console.log('Error al guardar el thumbnail ', err);
            });


    });



}

function deleteImagen(req: Request, res: Response) {
    var idField = req.params.idField;
    var idDocument = req.params.idDocument;
    // Puede tomar el nombre del archivo o "TODAS" para elimnar todas las imagenes del aviso
    var fileName = req.params.fileName;

    // update filelds in COMPANY collection

    if (['tx_company_images', 'tx_company_cover', 'tx_company_logo'].includes(idField)) {
        Company.findById(idDocument).then(companyDB => {

            if (!companyDB) {
                return res.status(400).json({
                    ok: false,
                    msg: "No existe el comercio para la imagen que desea eliminar",
                    filename: fileName
                });
            }

            // (..) in production

            var dirPath = `./uploads/${idDocument}/${idField}`;
            var absoluteDirPath = path.resolve(__dirname, '../', dirPath);

            if (idField === 'tx_company_images') {
                if (fileName === 'todas') {
                    companyDB.tx_company_images = [];
                } else {
                    companyDB.tx_company_images = companyDB.tx_company_images.filter(archivo => archivo != fileName);
                }
                fileSystem.syncFolder(dirPath, companyDB.tx_company_images);
            }

            if (idField === 'tx_company_cover') {
                companyDB.tx_company_cover = null;
                fileSystem.syncFolder(dirPath, []);
            }

            if (idField === 'tx_company_logo') {
                companyDB.tx_company_logo = null;
                fileSystem.syncFolder(dirPath, []);
            }

            companyDB.save().then(companySaved => {

                if (!companySaved) {
                    return res.status(400).json({
                        ok: false,
                        msg: "No se pudo eliminar de la BD la imagen: " + fileName,
                        filename: fileName
                    });
                }

                return res.status(200).json({
                    ok: true,
                    msg: "Imagenes eliminadas correctamente",
                    filename: fileName
                });


            });
        });
    }

    // update filelds in USER collection
    if (['tx_img'].includes(idField)) {
        User.findByIdAndUpdate(idDocument, { tx_img: fileName }).then(userDB => {

            if (!userDB) {
                return res.status(400).json({
                    ok: false,
                    msg: "No existe el usuario para la imagen que desea eliminar",
                    filename: fileName
                });
            }

            var dirPath = `./uploads/${idDocument}/${idField}`;


            if (idField === 'tx_img') {
                userDB.tx_img = null;
                fileSystem.syncFolder(dirPath, []);
            }

            userDB.save().then(userSaved => {

                if (!userSaved) {
                    return res.status(400).json({
                        ok: false,
                        msg: "No se pudo eliminar de la BD la imagen: " + fileName,
                        filename: fileName
                    });
                }

                return res.status(200).json({
                    ok: true,
                    msg: "Imagenes eliminadas correctamente",
                    filename: fileName
                });

            });
        })
    }

}

function saveDB(idField: string, idDocument: string, fileName: string, res: Response) {

    return new Promise((resolve, reject) => {

        // Company collection
        if (['tx_company_images', 'tx_company_cover', 'tx_company_logo'].includes(idField)) {
            Company.findById(idDocument).then(companyDB => {

                if (!companyDB) {
                    return reject({
                        ok: false,
                        msg: "El comercio no existe",
                        filename: fileName
                    });
                }

                if (idField === 'tx_company_images') {
                    let imagenesPermitidas = 12;
                    if (companyDB.tx_company_images.length >= imagenesPermitidas) {
                        return reject({
                            ok: false,
                            msg: `Supera el máximo de ${imagenesPermitidas} imagenes permitidas`,
                            filename: fileName
                        });
                    }
                    companyDB.tx_company_images.push(fileName);
                }

                if (idField === 'tx_company_cover') {
                    companyDB.tx_company_cover = fileName;
                }

                if (idField === 'tx_company_logo') {
                    companyDB.tx_company_logo = fileName;
                }

                companyDB.save().then(companySaved => {

                    if (!companySaved) {
                        return reject({
                            ok: false,
                            msg: "No se pudo guardar la imagen",
                            filename: fileName
                        });
                    }
                    return resolve({
                        ok: true,
                        msg: "Imagen guardada correctamente",
                        filename: fileName
                    });
                });
            });

        }

        // User collection
        if (['tx_img'].includes(idField)) {
            User.findById(idDocument).then(UserDB => {

                if (!UserDB) {
                    return reject({
                        ok: false,
                        msg: "El comercio no existe",
                        filename: fileName
                    });
                }

                UserDB.tx_img = fileName;

                UserDB.save().then(userSaved => {
                    if (!userSaved) {
                        return reject({
                            // ERROR DE BASE DE DATOS
                            ok: false,
                            msg: "No se pudo guardar la imagen",
                            filename: fileName
                        });
                    }
                    return resolve({
                        ok: true,
                        msg: "Imagen guardada correctamente",
                        filename: fileName
                    });
                });
            });
        }
    })
}

export = {
    uploadImagen,
    deleteImagen
}