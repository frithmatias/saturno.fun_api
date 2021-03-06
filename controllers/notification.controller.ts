import { Request, Response } from 'express';
import { getPublicKey } from '../notifications/push';
import { Subscription } from '../models/subscription.model';

import webpush from 'web-push';
import * as keys from '../notifications/vapid.json';
import { Notification } from '../models/notification.model';

webpush.setVapidDetails(
    'mailto:matiasfrith@gmail.com', // por si los servicios cambian
    keys.publicKey,
    keys.privateKey
);


// ========================================================
// PUSH Notifications Subscriptions
// ========================================================

function notificationSubscribe(req: Request, res: Response) {


    var body = req.body;
    body.expirationTime = + new Date().getTime() + 3600 * 24 * 7;

    var subscription = new Subscription(body);
    subscription.save().then(subscriptionSaved => {
        return res.status(200).json({
            ok: true,
            msg: 'Subscripción a notificaciones exitosa',
            subscription: subscriptionSaved
        })
    }).catch(() => {
        return res.status(400).json({
            ok: false,
            msg: 'No se pudo suscribir a las notificaciones',
            subscription: null
        })
    })


}

function notificationKey(req: Request, res: Response) {
    // return res.status(200).json({ 
    return res.status(200).send( // for encoding data with urlsafeBase64
        getPublicKey()
    )
}

function notificationPush(req: Request, res: Response) {


    const post = {
        title: req.body.title,
        msg: req.body.msg
    };

    Subscription.find({}).then(async (subscriptions: any) => {
        let subscriptors = subscriptions.length;
        for (let subscription of subscriptions) {

            await webpush.sendNotification(subscription, JSON.stringify(post))
                .then(() => { })
                .catch(() => {
                    subscriptors--;
                    subscription.remove().then((subscriptionRemoved: any) => {
                    })
                });
        }

        return res.status(200).json({
            ok: true,
            msg: 'Notificaciones enviadas',
            subscriptors
        })
    });





}

// ========================================================
// SYSTEM Notifications 
// ========================================================

function readNotifications(req: Request, res: Response) {

    const idOwner = req.body.idOwner;
    Notification.find({ id_owner: idOwner })
        .limit(10)
        .sort({ tm_notification: -1 })
        .then(notificationsDB => {

            if (!notificationsDB) {
                res.status(200).json({
                    ok: false,
                    msg: 'No hay notificaciones',
                    notifications: null
                })
            }

            res.status(200).json({
                ok: true,
                msg: 'Notificaciones obtenidas correctamente',
                notifications: notificationsDB
            })
        })

}


function updateNotificationsRead(req: Request, res: Response) {
    
    const idNotifications = req.body.idNotifications;
    const idUser = req.body.idUser;

    Notification.updateMany({ _id: {$in : idNotifications}}, {$push: {id_read: idUser}}).then(notificationsUpdated => {
        res.status(200).json({
            ok: true,
            msg: 'Notificaciones guardadas como leidas correctamente',
            notifications: notificationsUpdated
        })
    })
}

function updateNotificationRead(req: Request, res: Response) {
    
    const idNotification = req.body.idNotification;
    const idUser = req.body.idUser;

    Notification.findByIdAndUpdate(idNotification, {$push: {id_read: idUser}}).then(notificationUpdated => {
        res.status(200).json({
            ok: true,
            msg: 'Notificacion guardada como leida correctamente',
            notifications: notificationUpdated
        })
    })
}

export = {
    notificationSubscribe,
    notificationKey,
    notificationPush,
    readNotifications,
    updateNotificationRead,
    updateNotificationsRead
}
