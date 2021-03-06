import { Router } from 'express';

// MIDDLEWARES
import  mdAuth  from '../middlewares/auth';

// CONTROLLER
import SuperuserController from '../controllers/superuser.controller';

// ROUTES
const superuserRoutes = Router();

superuserRoutes.get('/checksuper', mdAuth.verificaToken, SuperuserController.checkSuper);
superuserRoutes.post('/createmenu', mdAuth.verificaToken, SuperuserController.createMenu);
superuserRoutes.get('/readmenu', mdAuth.verificaToken, SuperuserController.readMenu);
superuserRoutes.get('/readallcompanies', mdAuth.verificaToken, SuperuserController.readAllCompanies);
superuserRoutes.post('/updatemenu', mdAuth.verificaToken, SuperuserController.updateMenu);
superuserRoutes.delete('/deletemenu/:idMenu', mdAuth.verificaToken, SuperuserController.deleteMenu);

export default superuserRoutes;