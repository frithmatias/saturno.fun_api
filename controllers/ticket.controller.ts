// MODELS
import { Ticket } from '../models/ticket.model';
import { Position } from '../models/position.model';
import { Table } from '../models/table.model';
import { Section } from '../models/section.model';
import { TableSession } from '../models/table.session.model';
import { Settings } from '../models/settings.model';
import { Request, Response } from 'express';
import user from './user.controller';
import Server from '../classes/server';
import spm from '../classes/spm';
import cron from 'node-cron';
import colors from '../global/colors';
import Spm from '../classes/spm';
import nodemailer from 'nodemailer';
import { environment } from '../global/environment';
import moment from 'moment';
import Mail from '../classes/mail';

// run cron
cron.schedule('*/10 * * * * *', () => {
	checkScheduled();
})

// set moment locales
moment.locale('es');

// const reserve = "2021-02-25T00:00:00.000Z";
// console.log(moment(reserve).format('DD [de] MMMM [a las] HH:mm')) // 24 de febrero a las 21:00
// console.log(moment(reserve).fromNow()); // en 9 dias

// ========================================================
// interfaces
// ========================================================

interface availability {
	interval: Date;
	tables: number[] | tablesData[];
	capacity: number | null; // -> number when has NOT compatible tables, null has compatible options  
}

interface tablesData {
	nmTable: number,
	nmPersons: number,
	blReserved: boolean,
	ticketOwner?: Ticket
}


// ========================================================
// system methods
// ========================================================

async function checkScheduled() {
	const server = Server.instance; // singleton

	let scheduledTickets: Ticket[] = [];

	await Ticket.find({ tm_reserve: { $ne: null }, tm_provided: null, tm_end: null })
		.populate('id_company')
		.then(data => {
			scheduledTickets = data;
		}).catch(() => {
		})

	let waiting = scheduledTickets.filter(ticket => ticket.tx_status === 'waiting');
	let scheduled = scheduledTickets.filter(ticket => ticket.tx_status === 'scheduled');
	let assigned = scheduledTickets.filter(ticket => ticket.tx_status === 'assigned');

	console.log(`${colors.FgBlue}System:${colors.Reset}`, 'waiting:', waiting.length, ' scheduled: ', scheduled.length, ' assigned: ', assigned.length);

	for (let ticket of scheduledTickets) {
		if (!ticket.tm_reserve) {
			return;
		}



		// relative reservetion time from now to define event
		const now = +new Date().getTime();
		const timeToProvide = (ticket.tm_reserve?.getTime() - now) <= 0;
		const timeToReserve = (ticket.tm_reserve?.getTime() - now) <= 2 * 60 * 60 * 1000; // 2hrs
		const timeToTerminate = (now - ticket.tm_start?.getTime()) >= 10 * 60 * 1000; // 10 minutes 

		// company and reservation data for mail pourposes
		const txPlatform = ticket.tx_platform;
		const idUser = ticket.id_user;
		const txName = ticket.tx_name;
		const txCompanyName = ticket.id_company.tx_company_name;
		const txCompanyAddress = ticket.id_company.tx_address_street + ' ' + ticket.id_company.tx_address_number;
		const cdTables = ticket.cd_tables;
		const cdTablesStr = ticket.cd_tables.length > 1 ? 'las mesas' : 'la mesa';
		const tmRemaining = moment(ticket.tm_reserve).fromNow();


		// -------------------------------------------------------------
		// AFTER 10MIN OF TM_START: IF NOT CONFIRMED SET 'TERMINATED' W/ TM_END	
		// -------------------------------------------------------------

		if (ticket.tx_status === 'waiting' && timeToTerminate) {
			ticket.tx_status = 'terminated';
			ticket.tm_end = new Date();
			await ticket.save().then((ticketSaved) => {
				console.log('System: ', `Ticket de ${ticketSaved.tx_name} sin confirmar terminado.`)
				if (ticket.id_socket_client) { server.io.to(ticket.id_socket_client).emit('update-ticket', ticket); }
			})
		}

		// -------------------------------------------------------------
		// IN TIME: PROVIDE TABLES	
		// -------------------------------------------------------------

		if (ticket.tx_status === 'assigned' && timeToProvide) {
			Table.find({ id_section: ticket.id_section, nm_table: { $in: ticket.cd_tables } }).then(tablesToProvide => {

				if (!tablesToProvide) {
					return;
				}

				//CRON IN-TIME: proveyendo ticket y estableciendo estado waiting a las mesas asignadas...
				spm.provide(tablesToProvide, ticket).then(data => {
					server.io.to(ticket.id_company._id).emit('update-waiters');
				})

			})
		}

		// -------------------------------------------------------------
		// BEFORE 2HS AT TM_RESERVE: TABLE RESERVE AND TICKET ASSIGN
		// -------------------------------------------------------------

		if (ticket.tx_status === 'scheduled' && timeToReserve) {
			await Table.find({ id_section: ticket.id_section, nm_table: { $in: ticket.cd_tables } })
				.then(async tablesToReserve => {

					if (!tablesToReserve) {
						return;
					}

					// TABLES -> RESERVED
					// CRON 2HRS LEFT: asignando ticket y reservando mesas... 
					let allReserved = false;
					for (let [index, table] of tablesToReserve.entries()) {
						if (table.tx_status === 'idle' || table.tx_status === 'paused') {
							table.tx_status = 'reserved';
							await table.save().then(() => {
								server.io.to(ticket.id_company._id).emit('update-waiters');
							})
						}
					}

					let tablesReservedCount = tablesToReserve.filter(table => table.tx_status === 'reserved').length;
					allReserved = tablesReservedCount === ticket.cd_tables?.length ? true : false;

					// si todas las mesas quedaron reservadas dejo el ticket en estado ASSIGNED
					if (allReserved) {
						// TICKET -> ASSIGNED
						ticket.tx_status = 'assigned';
						await ticket.save().then((ticketSaved: Ticket) => {

							if ((txPlatform === 'facebook' || txPlatform === 'google') && ticketSaved.tm_reserve && idUser) {
								const messageToUser = `
Hola ${txName}, ya te reservamos ${cdTablesStr} ${cdTables} en ${txCompanyName}!. 

Te esperamos en ${tmRemaining} en ${txCompanyAddress}.

Para ver todas tus reservas o cancelarlas por favor hace click aquí:
https://saturno.fun/public/tickets

Muchas Gracias!
Saturno.fun`;
								Mail.sendMail('reservas', idUser, messageToUser);
							}

							// CRON 2HRS LEFT: Se reservaron correctamente todas las mesas asignadas al cliente.
							if (ticket.id_socket_client) { server.io.to(ticket.id_socket_client).emit('update-ticket', ticketSaved); }
						})
					}
				})

		}


	}


};

// ========================================================
// waiter methods
// ========================================================

function attendedTicket(req: Request, res: Response) {
	const server = Server.instance; // singleton

	const idTicket = req.body.idTicket;
	Ticket.findByIdAndUpdate(idTicket, { tx_call: null, tm_call: null }, { new: true }).then(ticketAttended => {
		if (ticketAttended) {
			server.io.to(ticketAttended.id_company).emit('update-waiters');
			if (ticketAttended.id_socket_client) { server.io.to(ticketAttended.id_socket_client).emit('update-clients'); }
			return res.status(200).json({
				ok: true,
				msg: 'El llamado al camarero fue atendido.',
				ticket: ticketAttended
			})
		}
	}).catch(() => {
		return res.status(400).json({
			ok: false,
			msg: 'Ocurrio un error al guardar la atención del camarero en el ticket.',
			ticket: null
		})
	})
};

function releaseTicket(req: Request, res: Response) {

	const ticket: Ticket = req.body.ticket;
	const server = Server.instance; // singleton

	let newStatus;

	if (ticket.tm_reserve) {
		newStatus = 'scheduled';
	} else {
		if (ticket.cd_tables) {
			newStatus = ticket.cd_tables.length > 0 ? 'assigned' : 'queued';
		} else {
			newStatus = 'queued';
		}
	}

	Ticket.findByIdAndUpdate(ticket._id, {
		tx_status: newStatus,
		id_session: null,
		tm_init: null,
		tm_provided: null,
		tm_att: null
	}, { new: true }).then((ticketReleased) => {

		if (!ticketReleased) {
			return res.status(400).json({
				ok: false,
				msg: "No se pudo guardar el ticket con su estado anterior",
				ticket: null
			})
		}


		if (ticketReleased.id_socket_client) {
			server.io.to(ticketReleased.id_socket_client).emit('update-ticket', ticketReleased);
		}

		// cierro la sesión de la mesa
		let idSession = ticket.id_session;

		TableSession.findByIdAndUpdate(idSession, { tm_end: new Date() }).then(async tableSessionCancelled => {

			if (!tableSessionCancelled) {
				return res.status(400).json({
					ok: false,
					msg: "No se pudo cancelar la sesión de la mesa",
					ticket: null
				})
			}

			// libero las mesas del ticket
			for (let idTable of tableSessionCancelled?.id_tables) {
				await Table.findByIdAndUpdate(idTable, { tx_status: 'paused', id_session: null });
			}

			// ticket released, update waiters table list
			server.io.to(ticketReleased.id_company).emit('update-waiters');

			return res.status(200).json({
				ok: true,
				msg: "Mesas liberadas correctamente",
				ticket: null
			})

		}).catch(() => {
			return res.status(400).json({
				ok: false,
				msg: "No se pudo cancelar la sesion de mesa",
				ticket: null
			})
		})

	}).catch(() => {
		return res.status(400).json({
			ok: false,
			msg: "No se pudo finalizar el ticket",
			ticket: null
		})
	})
}

async function endTicket(req: Request, res: Response) {
	const idTicket = req.body.idTicket;
	const reqBy = req.body.reqBy;
	const newStatus = reqBy === 'waiter' ? 'finished' : 'cancelled';
	await Ticket.findByIdAndUpdate(idTicket, { tx_status: newStatus, tm_end: new Date() }, { new: true })
		.populate('id_section')
		.then(async (ticketCancelled) => {

			if (!ticketCancelled) {
				return res.status(400).json({
					ok: false,
					msg: 'No se puedo cancelar el ticket',
					ticket: ticketCancelled
				})
			}

			if (ticketCancelled?.id_session) {

				let idSession = ticketCancelled.id_session;
				// si ya tenía asignada una sesión de mesa, pauso la mesa y cierro su sesión.
				await TableSession.findByIdAndUpdate(idSession, { tm_end: new Date() }).then(async sessionCanceled => {
					// let new_status = ticketCancelled.tm_att === null ? 'idle' : 'paused';

					if (!sessionCanceled) {
						return;
					}

					// en una sesión de mesa puedo tener asignadas una o mas mesas
					for (let idTable of sessionCanceled?.id_tables) {
						await Table.findByIdAndUpdate(idTable, { tx_status: 'paused', id_session: null });
					}

					const server = Server.instance; // singleton
					server.io.to(ticketCancelled.id_company).emit('update-waiters');
					if (ticketCancelled.id_socket_client) {
						server.io.to(ticketCancelled.id_socket_client).emit('update-ticket', ticketCancelled); // ticket-create component
					}

					return res.status(200).json({
						ok: true,
						msg: "Ticket finalalizado correctamente",
						ticket: null
					})

				}).catch(() => {

					return res.status(400).json({
						ok: false,
						msg: "No se pudo cancelar la sesion de mesa",
						ticket: null
					})

				})

			} else {

				const server = Server.instance; // singleton
				server.io.to(ticketCancelled.id_company).emit('update-waiters');
				server.io.to(ticketCancelled.id_company).emit('update-clients'); //ticket component
				if (ticketCancelled.id_socket_client) {
					server.io.to(ticketCancelled.id_socket_client).emit('update-ticket', ticketCancelled); // ticket-create component
				}
				return res.status(200).json({
					ok: true,
					msg: "Ticket finalizado correctamente",
					ticket: ticketCancelled
				})
			}



		}).catch(() => {
			return res.status(400).json({
				ok: false,
				msg: "No se pudo finalizar el ticket",
				ticket: null
			})
		})
}

// ========================================================
// public methods
// ========================================================

async function readAvailability(req: Request, res: Response) {
	// si existe una mesa con capacidad para cumplir con el requerimiento de nmPersons, entonces devuelvo 
	// POR CADA INTERVALO un tipo de 'availability' con tables:[3,5,7] que son las mesas compatibles y disponibles 
	// (filtro las reservadas). 

	// Si NO existe una mesa que pueda cumplir con ese requerimiento devuelvo POR CADA INTERVALO TODAS las mesas disponibles 
	// (filtro las reservadas) pero en lugar de mostrar los números de las mesas, muestro las capacidades 
	// esto es porque me sirve para mostrar opciones y hacer un cálculo sobre la capacidad restante del sector para armar 
	// una mesa.


	const nmPersons = req.body.nmPersons;
	const idSection = req.body.idSection;
	const tmReserve = req.body.dtReserve; // utc
	const dayStart = new Date(tmReserve);
	const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
	const intervals = [...Array(24).keys()]; // 0-23 

	let compatibleTables: number[] = []; // ie. [2,3,5,8] -> only compatible tables
	let sectionTables: number[] = []; // all tables numbers
	let sectionTablesFull: tablesData[] = [];  // all tables numbers and persons
	let scheduledTickets: Ticket[] = []; // tickets agendados para el día seleccionado y que tengan mesas compatibles asignadas
	let availability: availability[] = []; // return availability


	// ALL TABLES
	await Table.find({ id_section: idSection })
		.then(resp => {
			sectionTables = resp.map(table => table.nm_table);
			sectionTablesFull = resp.map(table => {
				return { nmTable: table.nm_table, nmPersons: table.nm_persons, blReserved: false }
			})
		})
		.catch(() => {
			return res.status(500).json({
				ok: false,
				msg: 'Error al obtener todas las mesas del sector',
				availability
			})
		})


	// COMPATIBLE TABLES
	await Table.find({ id_section: idSection, nm_persons: { $gte: nmPersons } })
		.then(resp => compatibleTables = resp.map(table => table.nm_table))
		.catch(() => {
			return res.status(500).json({
				ok: false,
				msg: 'Error al obtener las mesas compatibles',
				availability
			})
		})

	if (compatibleTables.length > 0) {
		// TICKETS WITH COMPATIBLE TABLES ASSIGNED
		await Ticket.find({ id_section: idSection, tx_status: { $in: ['scheduled', 'waiting'] }, tm_reserve: { $gte: dayStart, $lt: dayEnd }, cd_tables: { $in: compatibleTables } })
			.then(resp => {
				scheduledTickets = resp
			})
			.catch(() => {
				return res.status(500).json({
					ok: false,
					msg: 'Error al obtener los tickets en la agenda',
					availability
				})
			})

	} else {

		// ALL TICKETS
		await Ticket.find({ id_section: idSection, tx_status: { $in: ['scheduled', 'waiting'] }, tm_reserve: { $gte: dayStart, $lt: dayEnd } })
			.then(resp => {
				scheduledTickets = resp
			})
			.catch(() => {
				return res.status(500).json({
					ok: false,
					msg: 'Error al obtener los tickets en la agenda',
					availability
				})
			})
	}

	// FILTER BUSY TABLES BY INTERVAL
	for (let hr of intervals) {
		// SI HAY MESAS COMPATIBLES MIS MESAS DISPONIBLES SON LAS MESAS COMPATIBLES, SINO SINO TODAS LAS MESAS
		let availableTables: number[] = compatibleTables.length > 0 ? compatibleTables : sectionTables;

		// TICKETS PARA ESE INTERVALO		
		let scheduledTicketsInterval = scheduledTickets.filter(ticket => ticket.tm_reserve?.getHours() === hr);

		// FILTRO LAS MESAS RESERVADAS
		for (let ticket of scheduledTicketsInterval) { // for each scheduled ticket
			for (let table of ticket.cd_tables) { // for each table assigned in that ticket
				if (availableTables.includes(table)) { // remove table from my available tables list
					availableTables = availableTables.filter(nm => nm != table);
				}
			}
		}


		if (compatibleTables.length > 0) {
			availability.push({ interval: new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hr), tables: availableTables, capacity: 0 })
		} else {

			// array de mesas disponibles
			let newTables: tablesData[] = [];
			for (let table of sectionTablesFull) {
				if (availableTables.includes(table.nmTable)) {
					newTables.push({ nmTable: table.nmTable, nmPersons: table.nmPersons, blReserved: false })
				} else {
					const ticketOwner = scheduledTicketsInterval.find(ticket => ticket.cd_tables.includes(table.nmTable))
					newTables.push({ nmTable: table.nmTable, nmPersons: table.nmPersons, blReserved: true, ticketOwner: ticketOwner })
				}
			}

			// por la unión de mesas resto 2 personas por mesa, luego sumo 2 personas que entran en los extremos.
			let arrcapacity = newTables
				.filter(table => table.blReserved === false)
				.map(table => table.nmPersons < 4 ? 4 : table.nmPersons) //asumo que las mesas con menos de 4 son de 4

			// la capacidad total de las mesas libres (blReserved === false)
			let capacity: number = 0;
			if (arrcapacity.length > 0) { capacity = arrcapacity.reduce((a, b) => a + b) - (arrcapacity.length * 2) + 2; }
			availability.push({ interval: new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hr), tables: newTables, capacity })
		}

	}

	return res.status(200).json({
		ok: compatibleTables.length > 0 ? true : false,
		msg: 'Disponibilidad obtenida correctamente',
		availability
	})
}

async function readPending(req: Request, res: Response) {
	// obtiene los tickets 'pending', pasaron el estado 'waiting' y esperan asignación de mesa por un admin y pasar a estado 'scheduled'.

	const idCompany = req.body.idCompany;
	const idYear = req.body.idYear;
	const idMonth = req.body.idMonth;

	const firstDay = new Date(idYear, idMonth);
	const lastDay = new Date(idYear, idMonth + 1);

	await Ticket.find({ id_company: idCompany, tx_status: 'pending', tm_reserve: { $gte: firstDay, $lt: lastDay } })
		.populate('id_section')
		.then((ticketsDB: Ticket[]) => {

			if (!ticketsDB) {
				return res.status(200).json({
					ok: false,
					msg: 'No hay pendientes',
					pending: null
				})
			}

			return res.status(200).json({
				ok: true,
				msg: 'Pendientes obtenidos correctamente',
				pending: ticketsDB
			})

		})
		.catch(() => {
			return res.status(500).json({
				ok: false,
				msg: 'Error al obtener los pendientes',
				pending: null
			})
		})

}

function createTicket(req: Request, res: Response) {
	// SCHEDULE -> WAITING 
	// ADMIN(SCHEDULE) -> SCHEDULED 
	// WAITER(VIRTUAL QUEUE) -> QUEUED 

	const { blContingent, idSocket, txName, nmPersons, idSection, tmReserve, cdTables, idUser } = req.body;
	console.log(req.body)
	const server = Server.instance; // singleton

	const thisDay = + new Date().getDate();
	const thisMonth = + new Date().getMonth() + 1;
	const thisYear = + new Date().getFullYear();


	const dateReserve = tmReserve ? new Date(tmReserve) : null;
	Section.findById(idSection).then(async sectionDB => {

		if (!sectionDB) {
			return res.status(400).json({
				ok: false,
				msg: 'No existe el sector solicitado',
				ticket: null
			})
		}

		let idPosition: Number | null = null;

		// si no es reserva, entonces es espontáneo y calculo la posición en la cola virtual
		if (!tmReserve) {

			// busco la posición que le corresponde en la cola virtual
			let position = await Position.findOneAndUpdate({ id_section: idSection, id_year: thisYear, id_month: thisMonth, id_day: thisDay }, { $inc: { id_position: 1 } }, { new: true });

			if (position?.id_position) {

				idPosition = position.id_position;

			} else {

				// si no existe el primer turno lo crea
				let firstNumber = new Position({
					id_section: idSection,
					id_year: thisYear,
					id_month: thisMonth,
					id_day: thisDay,
					id_position: 1
				})

				firstNumber.save()
					.catch(() => {
						return res.status(400).json({
							ok: false,
							msg: "El nuevo status no se pudo guardar."
						});
					})

				idPosition = firstNumber.id_position;

			}

		}

		// agenda / cola virtual
		const txStatus = tmReserve ? (blContingent ? 'scheduled' : 'waiting') : 'queued';

		// guardo el ticket
		let ticket = new Ticket({
			id_company: sectionDB.id_company,
			id_section: idSection,
			id_session: null,
			nm_persons: nmPersons,
			bl_contingent: blContingent,
			bl_priority: false,
			tx_name: txName,
			tx_platform: null,
			id_user: idUser, //phone client, only for scheduled contingency tickets
			tx_call: null,
			tx_status: txStatus,
			cd_tables: cdTables || [],
			id_position: idPosition || null, // if tx_status:'scheduled' -> idPosition = null
			id_socket_client: idSocket,
			id_socket_waiter: null,
			tm_reserve: dateReserve || null,
			tm_start: + new Date().getTime(),
			tm_init: null,
			tm_call: null,
			tm_provided: null,
			tm_att: null,
			tm_end: null
		})

		ticket.save().then(async (ticketSaved) => {

			// obtengo las configuraciones para el comercio
			const settings = await Settings.findOne({ id_company: ticketSaved.id_company });

			if (txStatus === 'queued') {
				// si spm esta activado hago un push 
				let spmResp: string = settings?.bl_spm_auto ? await spm.push(ticket) : 'Ticket guardado y esperando mesa.';

				server.io.to(sectionDB.id_company).emit('update-waiters');

				return res.status(201).json({
					ok: true,
					msg: spmResp,
					ticket
				});

			} else if (txStatus === 'waiting') {

				return res.status(201).json({
					ok: true,
					msg: 'Ticket esperando confirmación',
					ticket
				});

			} else if (txStatus === 'scheduled') {

				return res.status(201).json({
					ok: true,
					msg: 'Ticket guardado y agendado',
					ticket
				});

			}





		}).catch((err) => {

			return res.status(400).json({
				ok: false,
				msg: "Error al guardar el ticket.",
				err
			});

		})


	}).catch(() => {
		return res.status(400).json({
			ok: false,
			msg: 'No se pudo obtener el sector solicitado',
			ticket: null
		})
	})

};

async function validateTicket(req: Request, res: Response) {
	// WAITING -> TERMINATED || PENDING || SCHEDULED

	const idTicket = req.body.idTicket;
	const txPlatform = req.body.txPlatform;
	const txToken = req.body.txToken || null;
	// those vars are not const cause from Google will receive a token to validate
	let idUser = req.body.idUser || null;
	let txImage = req.body.txImage || null;
	let txName = req.body.txName || null;

	if (!txPlatform || !idUser) {
		if (txPlatform) {
			return res.status(400).json({
				ok: false,
				msg: `No se pudo obtener el usuario de ${txPlatform} para validar el ticket`,
				ticket: null
			})
		} else {
			return res.status(400).json({
				ok: false,
				msg: `No se recibió la red social para validar el ticket`,
				ticket: null
			})
		}
	}

	if (txPlatform === 'google') {
		await user.verify(txToken).then((googleUser: any) => {
			idUser = googleUser.email;
			txName = googleUser.name;
			txImage = googleUser.img;
		})
	}

	const server = Server.instance; // singleton

	return await Ticket.findById(idTicket)
		.populate('id_company')
		.then(async (ticketWaiting) => {


			// 1. Verifico que el ticket existe
			if (!ticketWaiting) {
				return res.status(400).json({
					ok: false,
					msg: 'No existe el ticket a validar.',
					ticket: ticketWaiting
				})
			}

			// company and reservation data for mail pourposes
			const txCompanyName = ticketWaiting.id_company.tx_company_name;
			const txCompanyAddress = ticketWaiting.id_company.tx_address_street + ' ' + ticketWaiting.id_company.tx_address_number;
			const cdTables = ticketWaiting.cd_tables;
			const cdTablesStr = ticketWaiting.cd_tables.length > 1 ? 'las mesas' : 'la mesa';
			const tmRemaining = moment(ticketWaiting.tm_reserve).fromNow();

			// 2. Verifico que esté en su estado WAITING
			if (ticketWaiting.tx_status !== 'waiting') {
				if (ticketWaiting.id_socket_client) { server.io.to(ticketWaiting.id_socket_client).emit('update-ticket', ticketWaiting); }
				return res.status(400).json({
					ok: false,
					msg: 'El ticket no se encuentra en estado de validación',
					ticket: ticketWaiting
				})
			}

			// Obtengo los tickets activos para el sector y hacer otras verificaciones
			const ticketsActiveCompany = await Ticket.find({
				// _id: { $ne: ticketWaiting?._id }, // que no sea el que hay que validar
				// tx_platform: txPlatform,
				// id_user: idUser,
				id_section: ticketWaiting.id_section,
				tx_status: { $nin: ['cancelled', 'finished', 'terminated'] },
				id_company: ticketWaiting?.id_company._id,
				tm_end: null
			}).then((ticketsActiveCompany: Ticket[]) => {
				return ticketsActiveCompany;
			})

			// 3. Verifico que el usuario no tenga otro ticket activo para este negocio.
			const ticketsUser = ticketsActiveCompany.filter(ticket => ticket.tx_platform === txPlatform && ticket.id_user === idUser && ticket._id !== idTicket)
			if (ticketsUser && ticketsUser.length > 0) {
				ticketWaiting.tx_platform = txPlatform;
				ticketWaiting.id_user = idUser;
				ticketWaiting.tx_status = 'terminated';
				ticketWaiting.tm_end = new Date();
				return await ticketWaiting.save().then((ticketSaved: Ticket) => {
					if (ticketWaiting.id_socket_client) { server.io.to(ticketWaiting.id_socket_client).emit('update-ticket', ticketSaved); }
					return res.status(200).json({
						ok: false,
						msg: `Ya tenés un ticket activo para este negocio.`,
						ticket: ticketWaiting
					})
				})
			}

			// 4. SOLO si el ticket tiene una mesa compatible asignada verifico que la mesa que quiere reservar todavía esté disponible.
			if (ticketWaiting.cd_tables.length > 0) {
				const ticketsTable = ticketsActiveCompany.filter(ticket => ticket.tx_status === 'scheduled' && ticket.cd_tables.includes(ticketWaiting.cd_tables[0]) && ticket.tm_reserve?.getHours() === ticketWaiting.tm_reserve?.getHours() && ticket._id !== ticketWaiting._id)
				if (ticketsTable && ticketsTable.length > 0) {
					ticketWaiting.tx_platform = txPlatform;
					ticketWaiting.id_user = idUser;
					ticketWaiting.tx_status = 'terminated';
					ticketWaiting.tm_end = new Date();
					return await ticketWaiting.save().then((ticketSaved: Ticket) => {
						if (ticketWaiting.id_socket_client) { server.io.to(ticketWaiting.id_socket_client).emit('update-ticket', ticketSaved); }
						return res.status(400).json({
							ok: false,
							msg: `La mesa ya fué reservada por otro cliente.`,
							ticket: ticketWaiting
						})
					})
				}
			}


			// Pasó todas las verificaciones anteriores, se valida el ticket.
			ticketWaiting.tx_platform = txPlatform;
			ticketWaiting.id_user = idUser;
			ticketWaiting.tx_status = ticketWaiting.cd_tables.length === 0 ? 'pending' : 'scheduled';

			await ticketWaiting.save().then((ticketSaved: Ticket) => {


				// QUEDO AGENDADO Y ASIGNADO
				let response: string = '';
				if (ticketSaved.tx_status === 'scheduled') {
					response = `Reserva confirmada correctamente`
				}

				// QUEDO AGENDADO COMO REQUERIDO
				if (ticketSaved.tx_status === 'pending') {
					response = `Reserva pendiente de aprobación`
				}

				if ((txPlatform === 'facebook' || txPlatform === 'google') && ticketSaved.tm_reserve) {
					const messageToUser = `
Hola ${txName}, la reserva de ${cdTablesStr} ${cdTables} en ${txCompanyName} quedó confirmada.

Te esperamos en ${tmRemaining} en ${txCompanyAddress}.

Podés ver o cancelar tus reservas haciendo click aquí:
https://saturno.fun/public/tickets

Muchas Gracias!
Saturno.fun`;
					Mail.sendMail('reservas', idUser, messageToUser);
				}

				return res.status(200).json({
					ok: true,
					msg: response,
					ticket: ticketSaved
				})


			})

		}).catch(() => {
			return res.status(400).json({
				ok: false,
				msg: 'Error al confirmar el ticket o el ticket fué cancelado.',
				ticket: null
			})
		})

}

function callWaiter(req: Request, res: Response) {

	const { idTicket, txCall } = req.body;
	const server = Server.instance; // singleton

	Ticket.findByIdAndUpdate(idTicket, { tx_call: txCall, tm_call: new Date() }, { new: true }).then(ticketAttended => {

		if (ticketAttended) {

			server.io.to(ticketAttended.id_company).emit('update-waiters');

			return res.status(200).json({
				ok: true,
				msg: 'El camarero fue llamado.',
				ticket: ticketAttended
			})

		}

	}).catch(() => {
		return res.status(400).json({
			ok: false,
			msg: 'Ocurrio un error al llamar al camarero.',
			ticket: null
		})
	})
};

function readUserTickets(req: Request, res: Response) {

	const txPlatform = req.params.txPlatform;
	const idUser = req.params.idUser;

	Ticket.find({ tx_platform: txPlatform, id_user: idUser, tx_status: { $ne: 'terminated' } })
		.populate('id_company')
		.then((userTickets: Ticket[]) => {
			if (!userTickets) {
				return res.status(400).json({
					ok: false,
					msg: 'No hay tickets para el usuario',
					tickets: null
				})
			}

			return res.status(200).json({
				ok: true,
				msg: 'Se obtuvieron los tickets del usuario correctamente',
				tickets: userTickets
			})
		})
};

function readTickets(req: Request, res: Response) {
	const idCompany = req.params.idCompany;
	let year = + new Date().getFullYear();
	let month = + new Date().getMonth();
	let day = + new Date().getDate();
	let today = + new Date(year, month, day).getTime();
	let yesterday = new Date(today - (1000 * 60 * 60 * 24)); // Yesterday
	Ticket.find({
		id_company: idCompany, // only this company
		tm_start: { $gt: yesterday },  // only from Yesterday (now -24hs)
	})
		.populate({
			path: 'id_session id_section id_company',
			populate: { path: 'id_tables' }
		})
		.then((tickets) => {

			if (tickets.length > 0) {
				return res.status(200).json({
					ok: true,
					msg: "Tickets obtenidos correctamente",
					tickets
				});
			}

			return res.status(200).json({
				ok: true,
				msg: "No hay tickets",
				tickets: []
			});

		}).catch((err) => {
			return res.status(500).json({
				ok: false,
				msg: err,
				tickets: null
			});
		})
};

function readTicket(req: Request, res: Response) {

	const idTicket = req.params.idTicket;

	Ticket.findById(idTicket)
		.populate({
			path: 'id_session id_section id_company',
			populate: { path: 'id_tables' }
		})
		.then((ticket) => {

			if (!ticket) {
				return res.status(400).json({
					ok: false,
					msg: "No existe el ticket",
					ticket: null
				});
			}

			return res.status(200).json({
				ok: true,
				msg: "Se obtuvo el ticket correctamente",
				ticket
			});

		}).catch((err) => {
			return res.status(500).json({
				ok: false,
				msg: err,
				ticket: null
			});
		})
};

function updateSocket(req: Request, res: Response) {
	const server = Server.instance; // singleton

	const idTicket = req.body.idTicket;
	const newSocket = req.body.newSocket;
	const isClient = req.body.isClient;
	Ticket.findById(idTicket).then((ticketDB) => {

		if (!ticketDB) {
			return res.status(400).json({
				ok: false,
				msg: "No existe el ticket con el socket a actualizar."
			});
		}

		let requestUpdateTo: string;

		if (isClient) {
			ticketDB.id_socket_client = newSocket;
			if (ticketDB.id_socket_waiter) { requestUpdateTo = ticketDB.id_socket_waiter; }
		} else {
			ticketDB.id_socket_waiter = newSocket;
			if (ticketDB.id_socket_client) { requestUpdateTo = ticketDB.id_socket_client; }
		}



		ticketDB.save().then((ticketUpdated) => {
			// antes de enviar el ticket actualizado al solicitante, tengo que 
			// avisarle a la otra parte, que tiene que actualizar el ticket. 

			return res.status(200).json({
				ok: true,
				msg: "El socket del ticket fue actualizado correctamente.",
				ticket: ticketUpdated
			});


		}).catch(() => {

			return res.status(400).json({
				ok: false,
				msg: "Error al actualizar el socket del ticket."
			});

		})

	}).catch(() => {

		return res.status(400).json({
			ok: false,
			msg: "Error al obtener el socket del ticket."
		});

	})
}

export = {
	readAvailability,
	readPending,
	createTicket,
	validateTicket,
	callWaiter,
	releaseTicket,
	attendedTicket,
	endTicket,
	readUserTickets,
	readTickets,
	readTicket,
	updateSocket
}