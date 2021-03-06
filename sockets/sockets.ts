import { Socket } from 'socket.io';
import socketIO from 'socket.io';




// Borrar marcador
export const clientConnected = (cliente: Socket, io: socketIO.Server) => {

	cliente.on('enterCompany', (idCompany) => {
		cliente.join(idCompany);
		console.log('System: ', cliente.id, ' entrando a ', idCompany);
	})

	cliente.on('mensaje-publico', (payload: { de: string, cuerpo: string }) => {
		io.emit('mensaje-publico', payload);
	});

	cliente.on('chat-message', (payload: { to: string, msg: string }) => {
		io.to(payload.to).emit('chat-message', payload.msg);
	});
};

