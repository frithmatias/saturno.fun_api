import { Request, response, Response } from 'express';
import { Settings } from '../models/settings.model';
import Server from '../classes/server';

const server = Server.instance; // singleton

// ========================================================
// Setting Methods
// ========================================================

function readSettings(req: Request, res: Response) {
    let idCompany = req.params.idCompany;
    Settings.findOne({ id_company: idCompany }).then(settingsDB => {
        return res.status(200).json({
            ok: true,
            msg: 'Configuracion del comercio obtenida correctamente',
            settings: settingsDB
        })
    })
}

function updateSettings(req: Request, res: Response) {

    const idCompany = req.body._id;
    const blSpm = req.body.bl_spm;
    const blSchedule = req.body.bl_schedule;
    const blQueue = req.body.bl_queue;
    Settings.findByIdAndUpdate(idCompany, { bl_spm: blSpm, bl_schedule: blSchedule, bl_queue: blQueue }, {new: true}).then(settingsUpdated => {
        return res.status(200).json({
            ok: true,
            msg: 'Ajustes guardados correctamente',
            settings: settingsUpdated
        })

    }).catch(() => {
        return res.status(400).json({
            ok: false,
            msg: 'Error al actualizar los ajustes',
            settings: null
        })
    })
}

let sendMessage = (req: Request, res: Response): void => {

    let txMessage = String(req.body.txMessage);
    let idCompany = String(req.body.idCompany);


    if (txMessage && txMessage.length <= 100) {
        server.io.to(idCompany).emit('message-system', txMessage)
        res.status(200).json({
            ok: true,
            msg: 'Mensaje enviado correctemante', 
            text: null
        })
    }

}

export = {
    readSettings,
    updateSettings,
    sendMessage
}
