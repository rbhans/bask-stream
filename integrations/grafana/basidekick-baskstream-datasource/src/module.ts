import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import { BaskStreamDataSourceOptions, BaskStreamQuery } from './types';

export const plugin = new DataSourcePlugin<DataSource, BaskStreamQuery, BaskStreamDataSourceOptions>(DataSource)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
