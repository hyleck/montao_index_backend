import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CompanyApp } from '../schemas/company-app.schema';

@Injectable()
export class AppsService {
  constructor(@InjectModel(CompanyApp.name) private readonly appModel: Model<CompanyApp>) {}

  findAll() {
    return this.appModel.find().sort({ order: 1, name: 1 }).lean();
  }
}
